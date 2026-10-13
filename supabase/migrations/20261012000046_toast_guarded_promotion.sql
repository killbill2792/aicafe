-- Promoting a report-matched Toast pilot day into existing canonical sales.
-- Strictly additive, manual service-role RPC only; never called by webhook or scheduled jobs.
ALTER TABLE toast_pilot_days DROP CONSTRAINT IF EXISTS toast_pilot_days_state_check;
ALTER TABLE toast_pilot_days ADD CONSTRAINT toast_pilot_days_state_check
 CHECK(state IN ('awaiting_report','matched_owner_report','needs_review','promoted'));
ALTER TABLE toast_pilot_days ADD COLUMN IF NOT EXISTS promoted_at timestamptz;

CREATE OR REPLACE FUNCTION toast_promote_reconciled_day(
 p_business_id uuid, p_restaurant_guid uuid, p_location_id uuid,
 p_business_date date, p_expected_sha256 text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
 staged toast_pilot_days%ROWTYPE;
 rec jsonb;
 line jsonb;
 new_order_id uuid;
 linked_item uuid;
 order_count integer:=0;
 prefix text:='toast:'||p_restaurant_guid::text||':';
 external_id text;
BEGIN
 SELECT * INTO staged FROM toast_pilot_days
 WHERE business_id=p_business_id AND restaurant_guid=p_restaurant_guid
   AND location_id=p_location_id AND business_date=p_business_date
 FOR UPDATE;
 IF NOT FOUND OR staged.snapshot_sha256<>p_expected_sha256 OR
   staged.state NOT IN ('matched_owner_report','promoted') THEN
   RAISE EXCEPTION 'Toast day is not ready for promotion';
 END IF;
 IF jsonb_array_length(staged.orders_snapshot)<>staged.order_count OR
   jsonb_array_length(staged.orders_snapshot)>2000 THEN
   RAISE EXCEPTION 'Toast staged snapshot cardinality mismatch';
 END IF;
 -- If owner/CSV/Square business facts overlap, fail instead of deleting or double-counting.
 -- NULL location means an unallocated historical import and is therefore ambiguous.
 IF EXISTS (
   SELECT 1 FROM orders o WHERE o.business_id=p_business_id
    AND o.business_date=p_business_date
    AND (o.location_id=p_location_id OR o.location_id IS NULL)
    AND LEFT(o.pos_order_id,length(prefix))<>prefix
 ) THEN RAISE EXCEPTION 'Conflicting source facts need owner review'; END IF;
 -- Removed/voided orders need explicit historical correction review, not silent deletion.
 IF EXISTS (
   SELECT 1 FROM orders o WHERE o.business_id=p_business_id
    AND o.location_id=p_location_id AND o.business_date=p_business_date
    AND LEFT(o.pos_order_id,length(prefix))=prefix
    AND NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(staged.orders_snapshot) x
      WHERE x->>'posOrderId'=o.pos_order_id
    )
 ) THEN RAISE EXCEPTION 'Historical Toast order removed: review required'; END IF;

 FOR rec IN SELECT value FROM jsonb_array_elements(staged.orders_snapshot) LOOP
   external_id:=rec->>'posOrderId';
   IF external_id IS NULL OR LEFT(external_id,length(prefix))<>prefix OR
     rec->>'processingFeeStatus'<>'missing' OR
     (rec->>'processingFeeCents')::bigint<>0 OR
     jsonb_typeof(rec->'lines')<>'array' THEN
     RAISE EXCEPTION 'Invalid Toast order snapshot';
   END IF;
   -- Stable provider order ID, with source-owned financial cents. Never relabel fees actual.
   INSERT INTO orders (
     business_id,location_id,pos_order_id,closed_at,business_date,
     gross_sales_cents,discounts_cents,refunds_cents,tax_cents,tip_cents,
     processing_fee_cents,processing_fee_status,processing_fee_provider,net_sales_cents
   ) VALUES (
     p_business_id,p_location_id,external_id,(rec->>'closedAt')::timestamptz,p_business_date,
     (rec->>'grossSalesCents')::bigint,(rec->>'discountsCents')::bigint,
     (rec->>'refundsCents')::bigint,(rec->>'taxCents')::bigint,
     (rec->>'tipCents')::bigint,0,'missing','toast',(rec->>'netSalesCents')::bigint
   )
   ON CONFLICT (business_id,pos_order_id) DO UPDATE SET
      closed_at=EXCLUDED.closed_at,location_id=EXCLUDED.location_id,
      business_date=EXCLUDED.business_date,gross_sales_cents=EXCLUDED.gross_sales_cents,
      discounts_cents=EXCLUDED.discounts_cents,refunds_cents=EXCLUDED.refunds_cents,
      tax_cents=EXCLUDED.tax_cents,tip_cents=EXCLUDED.tip_cents,
      processing_fee_cents=0,processing_fee_status='missing',
      processing_fee_provider='toast',net_sales_cents=EXCLUDED.net_sales_cents
   RETURNING id INTO new_order_id;
   DELETE FROM order_lines WHERE order_id=new_order_id;
   FOR line IN SELECT value FROM jsonb_array_elements(rec->'lines') LOOP
     linked_item:=NULL;
     IF line->>'posItemId' IS NOT NULL THEN
       SELECT m.id INTO linked_item FROM menu_items m
       WHERE m.business_id=p_business_id AND m.pos_item_id=line->>'posItemId'
       ORDER BY m.id LIMIT 1;
     END IF;
     INSERT INTO order_lines(
       order_id,menu_item_id,pos_item_id,name,quantity,net_sales_cents,
       modifiers,voided,voided_by
     ) VALUES (
       new_order_id,linked_item,line->>'posItemId',line->>'name',
       (line->>'quantity')::numeric,(line->>'netSalesCents')::bigint,
       COALESCE(line->'modifiers','[]'::jsonb),
       COALESCE((line->>'voided')::boolean,false),line->>'voidedBy'
     );
   END LOOP;
   order_count:=order_count+1;
 END LOOP;
 IF order_count<>staged.order_count THEN
   RAISE EXCEPTION 'Toast promotion count mismatch';
 END IF;
 UPDATE toast_pilot_days SET state='promoted',promoted_at=now()
 WHERE business_id=p_business_id AND restaurant_guid=p_restaurant_guid
   AND business_date=p_business_date;
 RETURN order_count;
END $$;
REVOKE ALL ON FUNCTION toast_promote_reconciled_day(uuid,uuid,uuid,date,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION toast_promote_reconciled_day(uuid,uuid,uuid,date,text) TO service_role;
