-- Read-only research projections of existing verified financial evidence.
-- Preserve exact owner/cafe membership and lease semantics; no new writer or raw upload access.
SET lock_timeout='3s';
SET statement_timeout='45s';
GRANT aicafe_research_view_owner TO postgres WITH SET TRUE;

CREATE FUNCTION u3_research_private.financial_statement_documents_rows()
RETURNS TABLE(statement_id uuid,account_key text,currency_code text,statement_from date,statement_to date,opening_cents bigint,closing_cents bigint,transaction_count integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT u.id,u.financial_account_key,u.financial_currency,u.financial_from,u.financial_to,u.financial_opening_cents,u.financial_closing_cents,jsonb_array_length(u.financial_transactions)
 FROM u3_research_private.scope() s JOIN public.uploads u ON u.business_id=s.business_id AND u.financial_owner_user_id=s.owner_user_id
 WHERE s.mode IN ('owner','durable') AND u.kind='statement' AND u.status='done'
$rows$;
REVOKE ALL ON FUNCTION u3_research_private.financial_statement_documents_rows() FROM PUBLIC,anon,authenticated,aicafe_research;
GRANT EXECUTE ON FUNCTION u3_research_private.financial_statement_documents_rows() TO aicafe_research_view_owner,aicafe_research;
CREATE VIEW u3_research.financial_statement_documents WITH (security_barrier=true) AS SELECT * FROM u3_research_private.financial_statement_documents_rows();
COMMENT ON VIEW u3_research.financial_statement_documents IS 'Verified saved statement document; account_key is an opaque account grouping key, not an account number. Different statements can overlap. Closing balance is historical, not live cash.';
ALTER VIEW u3_research.financial_statement_documents OWNER TO aicafe_research_view_owner;
REVOKE ALL ON u3_research.financial_statement_documents FROM PUBLIC,anon,authenticated;
GRANT SELECT ON u3_research.financial_statement_documents TO aicafe_research;

CREATE FUNCTION u3_research_private.financial_statement_transactions_rows()
RETURNS TABLE(statement_id uuid,row_index integer,transaction_date date,amount_cents bigint,balance_cents bigint,currency_code text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT u.id,(t.v->>'i')::integer,(t.v->>'date')::date,(t.v->>'amountCents')::bigint,(t.v->>'balanceCents')::bigint,u.financial_currency
 FROM u3_research_private.scope() s JOIN public.uploads u ON u.business_id=s.business_id AND u.financial_owner_user_id=s.owner_user_id
 CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(u.financial_transactions)='array' THEN u.financial_transactions ELSE '[]'::jsonb END) t(v)
 WHERE s.mode IN ('owner','durable') AND u.kind='statement' AND u.status='done'
$rows$;
REVOKE ALL ON FUNCTION u3_research_private.financial_statement_transactions_rows() FROM PUBLIC,anon,authenticated,aicafe_research;
GRANT EXECUTE ON FUNCTION u3_research_private.financial_statement_transactions_rows() TO aicafe_research_view_owner,aicafe_research;
CREATE VIEW u3_research.financial_statement_transactions WITH (security_barrier=true) AS SELECT * FROM u3_research_private.financial_statement_transactions_rows();
COMMENT ON VIEW u3_research.financial_statement_transactions IS 'Each saved normalized bank statement row, including signed amount and ending balance. Join by statement_id; do not sum overlapping statement copies as distinct cash flows. No raw account details or narrative exposed.';
ALTER VIEW u3_research.financial_statement_transactions OWNER TO aicafe_research_view_owner;
REVOKE ALL ON u3_research.financial_statement_transactions FROM PUBLIC,anon,authenticated;
GRANT SELECT ON u3_research.financial_statement_transactions TO aicafe_research;

CREATE FUNCTION u3_research_private.financial_invoice_claims_rows()
RETURNS TABLE(invoice_id uuid,supplier_id uuid,purchase_order_id uuid,invoice_reference text,revision integer,issued_on date,due_on date,currency_code text,total_cents bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT i.id,i.supplier_id,i.purchase_order_id,i.invoice_reference,i.revision::integer,i.issued_on,i.due_on,i.currency_code,i.total_cents
 FROM u3_research_private.scope() s JOIN public.supplier_invoices i ON i.business_id=s.business_id AND i.owner_user_id=s.owner_user_id
 WHERE s.mode IN ('owner','durable')
$rows$;
REVOKE ALL ON FUNCTION u3_research_private.financial_invoice_claims_rows() FROM PUBLIC,anon,authenticated,aicafe_research;
GRANT EXECUTE ON FUNCTION u3_research_private.financial_invoice_claims_rows() TO aicafe_research_view_owner,aicafe_research;
CREATE VIEW u3_research.financial_invoice_claims WITH (security_barrier=true) AS SELECT * FROM u3_research_private.financial_invoice_claims_rows();
COMMENT ON VIEW u3_research.financial_invoice_claims IS 'Owner-owned invoice revisions; use latest applicable revision per supplier/reference. A due date is not proof of an unpaid balance. Match settlement evidence.';
ALTER VIEW u3_research.financial_invoice_claims OWNER TO aicafe_research_view_owner;
REVOKE ALL ON u3_research.financial_invoice_claims FROM PUBLIC,anon,authenticated;
GRANT SELECT ON u3_research.financial_invoice_claims TO aicafe_research;

CREATE FUNCTION u3_research_private.financial_bill_claims_rows()
RETURNS TABLE(bill_id uuid,payee text,bill_reference text,revision bigint,issued_on date,due_on date,amount_cents bigint,currency_code text,source_kind text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT u.id,u.financial_bill_payee,u.financial_bill_reference,u.financial_bill_revision,u.financial_bill_issued_on,u.financial_bill_due_on,u.financial_bill_amount_cents,u.financial_currency,u.financial_bill_source_kind
 FROM u3_research_private.scope() s JOIN public.uploads u ON u.business_id=s.business_id AND u.financial_owner_user_id=s.owner_user_id
 WHERE s.mode IN ('owner','durable') AND u.kind='bill_claim' AND u.status='done'
$rows$;
REVOKE ALL ON FUNCTION u3_research_private.financial_bill_claims_rows() FROM PUBLIC,anon,authenticated,aicafe_research;
GRANT EXECUTE ON FUNCTION u3_research_private.financial_bill_claims_rows() TO aicafe_research_view_owner,aicafe_research;
CREATE VIEW u3_research.financial_bill_claims WITH (security_barrier=true) AS SELECT * FROM u3_research_private.financial_bill_claims_rows();
COMMENT ON VIEW u3_research.financial_bill_claims IS 'Dated owner bill claims and revisions, not payment proof.';
ALTER VIEW u3_research.financial_bill_claims OWNER TO aicafe_research_view_owner;
REVOKE ALL ON u3_research.financial_bill_claims FROM PUBLIC,anon,authenticated;
GRANT SELECT ON u3_research.financial_bill_claims TO aicafe_research;

CREATE FUNCTION u3_research_private.financial_settlement_evidence_rows()
RETURNS TABLE(event_id uuid,invoice_id uuid,statement_id uuid,row_index bigint,transaction_date date,kind text,allocation_cents bigint,reverses_id uuid,source_revision text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT e.id,e.financial_invoice_id,e.financial_upload_id,e.financial_row_index,e.financial_tx_date,e.financial_kind,e.financial_allocation_cents,e.financial_reverses_id,e.source_revision::text
 FROM u3_research_private.scope() s JOIN public.purchase_reconciliation_events e ON e.business_id=s.business_id AND e.owner_user_id=s.owner_user_id
 WHERE s.mode IN ('owner','durable') AND e.financial_kind IN ('settlement_evidence_linked','settlement_evidence_reversed')
$rows$;
REVOKE ALL ON FUNCTION u3_research_private.financial_settlement_evidence_rows() FROM PUBLIC,anon,authenticated,aicafe_research;
GRANT EXECUTE ON FUNCTION u3_research_private.financial_settlement_evidence_rows() TO aicafe_research_view_owner,aicafe_research;
CREATE VIEW u3_research.financial_settlement_evidence WITH (security_barrier=true) AS SELECT * FROM u3_research_private.financial_settlement_evidence_rows();
COMMENT ON VIEW u3_research.financial_settlement_evidence IS 'Verified saved allocation and reversal events. Reversals subtract from linked allocations; never infer a payment from a date or an unrelated statement transaction.';
ALTER VIEW u3_research.financial_settlement_evidence OWNER TO aicafe_research_view_owner;
REVOKE ALL ON u3_research.financial_settlement_evidence FROM PUBLIC,anon,authenticated;
GRANT SELECT ON u3_research.financial_settlement_evidence TO aicafe_research;

