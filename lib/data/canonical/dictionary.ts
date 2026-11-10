// Single source of truth for owner-readable canonical views and AI column allowlist.
// Raw Toast records deliberately do not appear here.
export const canonicalViewNames = [
  "cv_sales_days",
  "cv_sales_hours",
  "cv_item_sales",
  "cv_payments",
  "cv_discounts",
  "cv_voids_refunds",
  "cv_card_fees",
  "cv_labor_entries",
  "cv_staff",
  "cv_shifts",
  "cv_menu",
  "cv_bills",
  "cv_inventory",
  "cv_owner_facts",
  "cv_analytics",
  "cv_orders",
  "cv_cash",
  "cv_kitchen",
  "cv_dining_options",
  "cv_toast_records"
] as const;
export type CanonicalView = typeof canonicalViewNames[number];
export const canonicalDictionary = {
  "cv_sales_days": {
    "meaning": "Daily shared café sales rollups",
    "columns": {
      "business_id": {
        "meaning": "Authenticated café UUID; never query other cafés.",
        "unit": "UUID",
        "source": "app",
        "example": "What data does my café have?"
      },
      "source": {
        "meaning": "Data origin: Toast, owner, or application.",
        "unit": "label",
        "source": "app",
        "example": "Where did this number come from?"
      },
      "source_ref": {
        "meaning": "Stable reference for the underlying fact.",
        "unit": "identifier",
        "source": "app",
        "example": "Which record supports it?"
      },
      "status": {
        "meaning": "Actual, estimated, open, needs match or owner provided.",
        "unit": "label",
        "source": "app",
        "example": "Which facts are incomplete?"
      },
      "business_date": {
        "meaning": "Café business date when recorded; null for undated reference facts.",
        "unit": "local date",
        "source": "app",
        "example": "What happened last week?"
      },
      "data": {
        "meaning": "Restricted, non-sensitive attributes relevant to this canonical entity.",
        "unit": "JSON",
        "source": "app",
        "example": "Show the source detail."
      },
      "net_sales_cents": {
        "meaning": "Recorded net sales in integer cents.",
        "unit": "cents",
        "source": "app",
        "example": "How much did we sell yesterday?"
      },
      "orders_count": {
        "meaning": "Number of recorded orders.",
        "unit": "count",
        "source": "app",
        "example": "How many orders yesterday?"
      }
    }
  },
  "cv_sales_hours": {
    "meaning": "Hourly recorded sales",
    "columns": {
      "business_id": {
        "meaning": "Authenticated café UUID; never query other cafés.",
        "unit": "UUID",
        "source": "app",
        "example": "What data does my café have?"
      },
      "source": {
        "meaning": "Data origin: Toast, owner, or application.",
        "unit": "label",
        "source": "app",
        "example": "Where did this number come from?"
      },
      "source_ref": {
        "meaning": "Stable reference for the underlying fact.",
        "unit": "identifier",
        "source": "app",
        "example": "Which record supports it?"
      },
      "status": {
        "meaning": "Actual, estimated, open, needs match or owner provided.",
        "unit": "label",
        "source": "app",
        "example": "Which facts are incomplete?"
      },
      "business_date": {
        "meaning": "Café business date when recorded; null for undated reference facts.",
        "unit": "local date",
        "source": "app",
        "example": "What happened last week?"
      },
      "data": {
        "meaning": "Restricted, non-sensitive attributes relevant to this canonical entity.",
        "unit": "JSON",
        "source": "app",
        "example": "Show the source detail."
      },
      "net_sales_cents": {
        "meaning": "Recorded net sales in integer cents.",
        "unit": "cents",
        "source": "app",
        "example": "How much did we sell yesterday?"
      },
      "orders_count": {
        "meaning": "Number of recorded orders.",
        "unit": "count",
        "source": "app",
        "example": "How many orders yesterday?"
      }
    }
  },
  "cv_item_sales": {
    "meaning": "Individual sold items",
    "columns": {
      "order_duration_seconds": {
        "meaning": "Time from recorded Toast open to close; repeats on lines of the same order.",
        "unit": "seconds",
        "source": "toast",
        "example": "How long were orders open?"
      },
      "item_taxes": {
        "meaning": "Order's selection tax amounts and rates, with selection identifiers.",
        "unit": "JSON cents/rate",
        "source": "toast",
        "example": "What tax was charged per item?"
      },
      "modifier_prices": {
        "meaning": "Provider modifier prices linked to each selection; unknown prices stay null.",
        "unit": "JSON cents",
        "source": "toast",
        "example": "What did modifiers cost?"
      },
      "business_id": {
        "meaning": "Authenticated café UUID; never query other cafés.",
        "unit": "UUID",
        "source": "app",
        "example": "What data does my café have?"
      },
      "source": {
        "meaning": "Data origin: Toast, owner, or application.",
        "unit": "label",
        "source": "app",
        "example": "Where did this number come from?"
      },
      "source_ref": {
        "meaning": "Stable reference for the underlying fact.",
        "unit": "identifier",
        "source": "app",
        "example": "Which record supports it?"
      },
      "status": {
        "meaning": "Actual, estimated, open, needs match or owner provided.",
        "unit": "label",
        "source": "app",
        "example": "Which facts are incomplete?"
      },
      "business_date": {
        "meaning": "Café business date when recorded; null for undated reference facts.",
        "unit": "local date",
        "source": "app",
        "example": "What happened last week?"
      },
      "data": {
        "meaning": "Restricted, non-sensitive attributes relevant to this canonical entity.",
        "unit": "JSON",
        "source": "app",
        "example": "Show the source detail."
      },
      "net_sales_cents": {
        "meaning": "Recorded net sales in integer cents.",
        "unit": "cents",
        "source": "app",
        "example": "How much did we sell yesterday?"
      },
      "quantity": {
        "meaning": "Recorded item quantity, including fractional units.",
        "unit": "items",
        "source": "app",
        "example": "How many sold?"
      }
    }
  },
  "cv_payments": {
    "meaning": "Sanitized Toast payments",
    "columns": {
      "payment_type": {
        "meaning": "Toast payment method (card/cash/gift), when supplied.",
        "unit": "label",
        "source": "toast",
        "example": "How much was paid by card?"
      },
      "card_type": {
        "meaning": "Card network/type from Toast, when supplied.",
        "unit": "label",
        "source": "toast",
        "example": "What was Visa volume?"
      },
      "card_entry_mode": {
        "meaning": "How the card was entered, from Toast.",
        "unit": "label",
        "source": "toast",
        "example": "What were keyed-card fees?"
      },
      "original_processing_fee_cents": {
        "meaning": "Original Toast-reported fee, not an estimate.",
        "unit": "cents",
        "source": "toast",
        "example": "What fee did Toast report?"
      },
      "processing_fee_cents": {
        "meaning": "Selected fee per payment, or null when unknown.",
        "unit": "cents",
        "source": "toast",
        "example": "What were the processing fees?"
      },
      "fee_status": {
        "meaning": "Actual, estimated or missing fee provenance.",
        "unit": "label",
        "source": "toast",
        "example": "Which fees are estimates?"
      },
      "business_id": {
        "meaning": "Authenticated café UUID; never query other cafés.",
        "unit": "UUID",
        "source": "app",
        "example": "What data does my café have?"
      },
      "source": {
        "meaning": "Data origin: Toast, owner, or application.",
        "unit": "label",
        "source": "app",
        "example": "Where did this number come from?"
      },
      "source_ref": {
        "meaning": "Stable reference for the underlying fact.",
        "unit": "identifier",
        "source": "app",
        "example": "Which record supports it?"
      },
      "status": {
        "meaning": "Actual, estimated, open, needs match or owner provided.",
        "unit": "label",
        "source": "app",
        "example": "Which facts are incomplete?"
      },
      "business_date": {
        "meaning": "Café business date when recorded; null for undated reference facts.",
        "unit": "local date",
        "source": "app",
        "example": "What happened last week?"
      },
      "data": {
        "meaning": "Restricted, non-sensitive attributes relevant to this canonical entity.",
        "unit": "JSON",
        "source": "app",
        "example": "Show the source detail."
      },
      "amount_cents": {
        "meaning": "Recorded amount, or null when unknown.",
        "unit": "cents",
        "source": "app",
        "example": "How much was it?"
      },
      "tip_cents": {
        "meaning": "Tip portion in integer cents; null when unknown.",
        "unit": "cents",
        "source": "toast",
        "example": "What tips were paid?"
      }
    }
  },
  "cv_discounts": {
    "meaning": "Imported, finalized order discount arrays for screens. One row represents an order, NOT one discount use; do not count these rows to answer how many discounts were applied today. For precise per-use counts, read cv_toast_records item_discount and check_discount, filtering counts_in_sales=true.",
    "columns": {
      "check_discounts": {
        "meaning": "Check-level discounts grouped inside one imported order. A discount use is each non-VOID entry, not this array or the number of checks. Excludes removed discounts.",
        "unit": "JSON cents",
        "source": "toast",
        "example": "Which discount names were used?"
      },
      "item_discounts": {
        "meaning": "Item-level discounts grouped inside one imported order. Multiple uses may belong to one order. Excludes removed discounts.",
        "unit": "JSON cents",
        "source": "toast",
        "example": "Which items received discounts?"
      },
      "business_id": {
        "meaning": "Authenticated café UUID; never query other cafés.",
        "unit": "UUID",
        "source": "app",
        "example": "What data does my café have?"
      },
      "source": {
        "meaning": "Data origin: Toast, owner, or application.",
        "unit": "label",
        "source": "app",
        "example": "Where did this number come from?"
      },
      "source_ref": {
        "meaning": "Stable reference for the underlying fact.",
        "unit": "identifier",
        "source": "app",
        "example": "Which record supports it?"
      },
      "status": {
        "meaning": "Actual, estimated, open, needs match or owner provided.",
        "unit": "label",
        "source": "app",
        "example": "Which facts are incomplete?"
      },
      "business_date": {
        "meaning": "Café business date when recorded; null for undated reference facts.",
        "unit": "local date",
        "source": "app",
        "example": "What happened last week?"
      },
      "data": {
        "meaning": "Restricted, non-sensitive attributes relevant to this canonical entity.",
        "unit": "JSON",
        "source": "app",
        "example": "Show the source detail."
      },
      "amount_cents": {
        "meaning": "Recorded amount, or null when unknown.",
        "unit": "cents",
        "source": "app",
        "example": "How much was it?"
      }
    }
  },
  "cv_voids_refunds": {
    "meaning": "Toast void/refund evidence",
    "columns": {
      "provider_details": {
        "meaning": "Provider-reported void/refund reasons and amounts from current committed order evidence.",
        "unit": "JSON",
        "source": "toast",
        "example": "Why was this item voided?"
      },
      "business_id": {
        "meaning": "Authenticated café UUID; never query other cafés.",
        "unit": "UUID",
        "source": "app",
        "example": "What data does my café have?"
      },
      "source": {
        "meaning": "Data origin: Toast, owner, or application.",
        "unit": "label",
        "source": "app",
        "example": "Where did this number come from?"
      },
      "source_ref": {
        "meaning": "Stable reference for the underlying fact.",
        "unit": "identifier",
        "source": "app",
        "example": "Which record supports it?"
      },
      "status": {
        "meaning": "Actual, estimated, open, needs match or owner provided.",
        "unit": "label",
        "source": "app",
        "example": "Which facts are incomplete?"
      },
      "business_date": {
        "meaning": "Café business date when recorded; null for undated reference facts.",
        "unit": "local date",
        "source": "app",
        "example": "What happened last week?"
      },
      "data": {
        "meaning": "Restricted, non-sensitive attributes relevant to this canonical entity.",
        "unit": "JSON",
        "source": "app",
        "example": "Show the source detail."
      },
      "amount_cents": {
        "meaning": "Recorded amount, or null when unknown.",
        "unit": "cents",
        "source": "app",
        "example": "How much was it?"
      }
    }
  },
  "cv_card_fees": {
    "meaning": "Actual or estimated card fees",
    "columns": {
      "business_id": {
        "meaning": "Authenticated café UUID; never query other cafés.",
        "unit": "UUID",
        "source": "app",
        "example": "What data does my café have?"
      },
      "source": {
        "meaning": "Data origin: Toast, owner, or application.",
        "unit": "label",
        "source": "app",
        "example": "Where did this number come from?"
      },
      "source_ref": {
        "meaning": "Stable reference for the underlying fact.",
        "unit": "identifier",
        "source": "app",
        "example": "Which record supports it?"
      },
      "status": {
        "meaning": "Actual, estimated, open, needs match or owner provided.",
        "unit": "label",
        "source": "app",
        "example": "Which facts are incomplete?"
      },
      "business_date": {
        "meaning": "Café business date when recorded; null for undated reference facts.",
        "unit": "local date",
        "source": "app",
        "example": "What happened last week?"
      },
      "data": {
        "meaning": "Restricted, non-sensitive attributes relevant to this canonical entity.",
        "unit": "JSON",
        "source": "app",
        "example": "Show the source detail."
      },
      "amount_cents": {
        "meaning": "Recorded amount, or null when unknown.",
        "unit": "cents",
        "source": "app",
        "example": "How much was it?"
      }
    }
  },
  "cv_labor_entries": {
    "meaning": "Recorded timecards",
    "columns": {
      "regular_hours": {
        "meaning": "Regular hours exactly supplied by Toast; nullable.",
        "unit": "hours",
        "source": "toast",
        "example": "What regular hours did Toast record?"
      },
      "overtime_hours": {
        "meaning": "Overtime hours exactly supplied by Toast; nullable.",
        "unit": "hours",
        "source": "toast",
        "example": "What overtime did Toast record?"
      },
      "hourly_wage_cents": {
        "meaning": "Recorded hourly wage in integer cents; nullable when unknown.",
        "unit": "cents/hour",
        "source": "toast",
        "example": "What wage did Toast supply?"
      },
      "business_id": {
        "meaning": "Authenticated café UUID; never query other cafés.",
        "unit": "UUID",
        "source": "app",
        "example": "What data does my café have?"
      },
      "source": {
        "meaning": "Data origin: Toast, owner, or application.",
        "unit": "label",
        "source": "app",
        "example": "Where did this number come from?"
      },
      "source_ref": {
        "meaning": "Stable reference for the underlying fact.",
        "unit": "identifier",
        "source": "app",
        "example": "Which record supports it?"
      },
      "status": {
        "meaning": "Actual, estimated, open, needs match or owner provided.",
        "unit": "label",
        "source": "app",
        "example": "Which facts are incomplete?"
      },
      "business_date": {
        "meaning": "Café business date when recorded; null for undated reference facts.",
        "unit": "local date",
        "source": "app",
        "example": "What happened last week?"
      },
      "data": {
        "meaning": "Restricted, non-sensitive attributes relevant to this canonical entity.",
        "unit": "JSON",
        "source": "app",
        "example": "Show the source detail."
      }
    }
  },
  "cv_staff": {
    "meaning": "Employee roster",
    "columns": {
      "business_id": {
        "meaning": "Authenticated café UUID; never query other cafés.",
        "unit": "UUID",
        "source": "app",
        "example": "What data does my café have?"
      },
      "source": {
        "meaning": "Data origin: Toast, owner, or application.",
        "unit": "label",
        "source": "app",
        "example": "Where did this number come from?"
      },
      "source_ref": {
        "meaning": "Stable reference for the underlying fact.",
        "unit": "identifier",
        "source": "app",
        "example": "Which record supports it?"
      },
      "status": {
        "meaning": "Actual, estimated, open, needs match or owner provided.",
        "unit": "label",
        "source": "app",
        "example": "Which facts are incomplete?"
      },
      "business_date": {
        "meaning": "Café business date when recorded; null for undated reference facts.",
        "unit": "local date",
        "source": "app",
        "example": "What happened last week?"
      },
      "data": {
        "meaning": "Restricted, non-sensitive attributes relevant to this canonical entity.",
        "unit": "JSON",
        "source": "app",
        "example": "Show the source detail."
      }
    }
  },
  "cv_shifts": {
    "meaning": "Published application shifts",
    "columns": {
      "business_id": {
        "meaning": "Authenticated café UUID; never query other cafés.",
        "unit": "UUID",
        "source": "app",
        "example": "What data does my café have?"
      },
      "source": {
        "meaning": "Data origin: Toast, owner, or application.",
        "unit": "label",
        "source": "app",
        "example": "Where did this number come from?"
      },
      "source_ref": {
        "meaning": "Stable reference for the underlying fact.",
        "unit": "identifier",
        "source": "app",
        "example": "Which record supports it?"
      },
      "status": {
        "meaning": "Actual, estimated, open, needs match or owner provided.",
        "unit": "label",
        "source": "app",
        "example": "Which facts are incomplete?"
      },
      "business_date": {
        "meaning": "Café business date when recorded; null for undated reference facts.",
        "unit": "local date",
        "source": "app",
        "example": "What happened last week?"
      },
      "data": {
        "meaning": "Restricted, non-sensitive attributes relevant to this canonical entity.",
        "unit": "JSON",
        "source": "app",
        "example": "Show the source detail."
      }
    }
  },
  "cv_menu": {
    "meaning": "Current catalog",
    "columns": {
      "business_id": {
        "meaning": "Authenticated café UUID; never query other cafés.",
        "unit": "UUID",
        "source": "app",
        "example": "What data does my café have?"
      },
      "source": {
        "meaning": "Data origin: Toast, owner, or application.",
        "unit": "label",
        "source": "app",
        "example": "Where did this number come from?"
      },
      "source_ref": {
        "meaning": "Stable reference for the underlying fact.",
        "unit": "identifier",
        "source": "app",
        "example": "Which record supports it?"
      },
      "status": {
        "meaning": "Actual, estimated, open, needs match or owner provided.",
        "unit": "label",
        "source": "app",
        "example": "Which facts are incomplete?"
      },
      "business_date": {
        "meaning": "Café business date when recorded; null for undated reference facts.",
        "unit": "local date",
        "source": "app",
        "example": "What happened last week?"
      },
      "data": {
        "meaning": "Restricted, non-sensitive attributes relevant to this canonical entity.",
        "unit": "JSON",
        "source": "app",
        "example": "Show the source detail."
      }
    }
  },
  "cv_bills": {
    "meaning": "Recurring owner costs",
    "columns": {
      "business_id": {
        "meaning": "Authenticated café UUID; never query other cafés.",
        "unit": "UUID",
        "source": "app",
        "example": "What data does my café have?"
      },
      "source": {
        "meaning": "Data origin: Toast, owner, or application.",
        "unit": "label",
        "source": "app",
        "example": "Where did this number come from?"
      },
      "source_ref": {
        "meaning": "Stable reference for the underlying fact.",
        "unit": "identifier",
        "source": "app",
        "example": "Which record supports it?"
      },
      "status": {
        "meaning": "Actual, estimated, open, needs match or owner provided.",
        "unit": "label",
        "source": "app",
        "example": "Which facts are incomplete?"
      },
      "business_date": {
        "meaning": "Café business date when recorded; null for undated reference facts.",
        "unit": "local date",
        "source": "app",
        "example": "What happened last week?"
      },
      "data": {
        "meaning": "Restricted, non-sensitive attributes relevant to this canonical entity.",
        "unit": "JSON",
        "source": "app",
        "example": "Show the source detail."
      }
    }
  },
  "cv_inventory": {
    "meaning": "App pantry counts and retained current Toast inventory objects; unknown stock is not zero",
    "columns": {
      "business_id": {
        "meaning": "Authenticated café UUID; never query other cafés.",
        "unit": "UUID",
        "source": "app",
        "example": "What data does my café have?"
      },
      "source": {
        "meaning": "Data origin: Toast, owner, or application.",
        "unit": "label",
        "source": "app",
        "example": "Where did this number come from?"
      },
      "source_ref": {
        "meaning": "Stable reference for the underlying fact.",
        "unit": "identifier",
        "source": "app",
        "example": "Which record supports it?"
      },
      "status": {
        "meaning": "Actual, estimated, open, needs match or owner provided.",
        "unit": "label",
        "source": "app",
        "example": "Which facts are incomplete?"
      },
      "business_date": {
        "meaning": "Café business date when recorded; null for undated reference facts.",
        "unit": "local date",
        "source": "app",
        "example": "What happened last week?"
      },
      "data": {
        "meaning": "Restricted, non-sensitive attributes relevant to this canonical entity.",
        "unit": "JSON",
        "source": "app",
        "example": "Show the source detail."
      },
      "menu_item_ref": {
        "meaning": "Toast menu-item reference from current retained provider stock; absent items are not zero.",
        "unit": "identifier",
        "source": "toast",
        "example": "What was recorded?"
      },
      "stock_status": {
        "meaning": "Toast OUT_OF_STOCK or QUANTITY status; null for app pantry rows.",
        "unit": "label",
        "source": "toast",
        "example": "What was recorded?"
      },
      "quantity": {
        "meaning": "Reported quantity when known; pantry base quantity for app rows.",
        "unit": "quantity",
        "source": "toast",
        "example": "What was recorded?"
      }
    }
  },
  "cv_owner_facts": {
    "meaning": "Persisted owner answers",
    "columns": {
      "business_id": {
        "meaning": "Authenticated café UUID; never query other cafés.",
        "unit": "UUID",
        "source": "app",
        "example": "What data does my café have?"
      },
      "source": {
        "meaning": "Data origin: Toast, owner, or application.",
        "unit": "label",
        "source": "app",
        "example": "Where did this number come from?"
      },
      "source_ref": {
        "meaning": "Stable reference for the underlying fact.",
        "unit": "identifier",
        "source": "app",
        "example": "Which record supports it?"
      },
      "status": {
        "meaning": "Actual, estimated, open, needs match or owner provided.",
        "unit": "label",
        "source": "app",
        "example": "Which facts are incomplete?"
      },
      "business_date": {
        "meaning": "Café business date when recorded; null for undated reference facts.",
        "unit": "local date",
        "source": "app",
        "example": "What happened last week?"
      },
      "data": {
        "meaning": "Restricted, non-sensitive attributes relevant to this canonical entity.",
        "unit": "JSON",
        "source": "app",
        "example": "Show the source detail."
      }
    }
  },
  "cv_analytics": {
    "meaning": "Typed Toast ERA measurements",
    "columns": {
      "business_id": {
        "meaning": "Authenticated café UUID; never query other cafés.",
        "unit": "UUID",
        "source": "app",
        "example": "What data does my café have?"
      },
      "source": {
        "meaning": "Data origin: Toast, owner, or application.",
        "unit": "label",
        "source": "app",
        "example": "Where did this number come from?"
      },
      "source_ref": {
        "meaning": "Stable reference for the underlying fact.",
        "unit": "identifier",
        "source": "app",
        "example": "Which record supports it?"
      },
      "status": {
        "meaning": "Actual, estimated, open, needs match or owner provided.",
        "unit": "label",
        "source": "app",
        "example": "Which facts are incomplete?"
      },
      "business_date": {
        "meaning": "Café business date when recorded; null for undated reference facts.",
        "unit": "local date",
        "source": "app",
        "example": "What happened last week?"
      },
      "data": {
        "meaning": "Restricted, non-sensitive attributes relevant to this canonical entity.",
        "unit": "JSON",
        "source": "app",
        "example": "Show the source detail."
      },
      "value_numeric": {
        "meaning": "Numeric ERA measurement; money metrics use cents.",
        "unit": "metric-dependent",
        "source": "toast",
        "example": "What did Toast report?"
      }
    }
  },
  "cv_orders": {
    "meaning": "Order dining options, source channels and guest counts for stored café orders.",
    "columns": {
      "business_id": {
        "meaning": "Authenticated café UUID; never query other cafés.",
        "unit": "UUID",
        "source": "app",
        "example": "What data does my café have?"
      },
      "source": {
        "meaning": "Data origin: Toast, owner, or application.",
        "unit": "label",
        "source": "app",
        "example": "Where did this number come from?"
      },
      "source_ref": {
        "meaning": "Reference to stored evidence, not a guest identity.",
        "unit": "identifier",
        "source": "app",
        "example": "Which record supports it?"
      },
      "status": {
        "meaning": "Actual, open or incomplete; capture-only is not live POS coverage.",
        "unit": "label",
        "source": "app",
        "example": "Is this record complete?"
      },
      "business_date": {
        "meaning": "Café local business date of the retained current Toast record, when supplied.",
        "unit": "local date",
        "source": "app",
        "example": "What happened on this date?"
      },
      "data": {
        "meaning": "Limited non-sensitive fields; no raw POS or customer payload.",
        "unit": "JSON",
        "source": "app",
        "example": "Show the provider detail."
      },
      "order_ref": {
        "meaning": "Stored order reference, not a guest identifier.",
        "unit": "identifier",
        "source": "app",
        "example": "What was recorded?"
      },
      "dining_option": {
        "meaning": "Dining option identifier or name from the order when supplied.",
        "unit": "label",
        "source": "toast",
        "example": "What was recorded?"
      },
      "source_channel": {
        "meaning": "POS-provided order channel when supplied.",
        "unit": "label",
        "source": "toast",
        "example": "What was recorded?"
      },
      "guest_count": {
        "meaning": "Number of guests reported on the order, when available.",
        "unit": "count",
        "source": "toast",
        "example": "What was recorded?"
      },
      "net_sales_cents": {
        "meaning": "Current recorded order net sales in cents; null when the order is excluded or superseded (the original amount remains in data for review).",
        "unit": "cents",
        "source": "app",
        "example": "What were sales by channel?"
      }
    }
  },
  "cv_cash": {
    "meaning": "Retained current Toast cash movements and deposits, not diagnostic captures; source freshness and permissions remain unverified until the relevant live sync proves coverage.",
    "columns": {
      "business_id": {
        "meaning": "Authenticated café UUID; never query other cafés.",
        "unit": "UUID",
        "source": "app",
        "example": "What data does my café have?"
      },
      "source": {
        "meaning": "Data origin: Toast, owner, or application.",
        "unit": "label",
        "source": "app",
        "example": "Where did this number come from?"
      },
      "source_ref": {
        "meaning": "Reference to stored evidence, not a guest identity.",
        "unit": "identifier",
        "source": "app",
        "example": "Which record supports it?"
      },
      "status": {
        "meaning": "Actual, open or incomplete; capture-only is not live POS coverage.",
        "unit": "label",
        "source": "app",
        "example": "Is this record complete?"
      },
      "business_date": {
        "meaning": "Café local business date of the retained current Toast record, when supplied.",
        "unit": "local date",
        "source": "app",
        "example": "What happened on this date?"
      },
      "data": {
        "meaning": "Limited non-sensitive fields; no raw POS or customer payload.",
        "unit": "JSON",
        "source": "app",
        "example": "Show the provider detail."
      },
      "entry_type": {
        "meaning": "Cash entry action or deposit type.",
        "unit": "label",
        "source": "toast",
        "example": "What was recorded?"
      },
      "amount_cents": {
        "meaning": "Reported cash movement amount in cents; null when missing.",
        "unit": "cents",
        "source": "toast",
        "example": "What was recorded?"
      },
      "cash_drawer_ref": {
        "meaning": "Redacted drawer identifier, if supplied.",
        "unit": "identifier",
        "source": "toast",
        "example": "What was recorded?"
      },
      "employee_ref": {
        "meaning": "Redacted employee identifier, if supplied.",
        "unit": "identifier",
        "source": "toast",
        "example": "What was recorded?"
      }
    }
  },
  "cv_kitchen": {
    "meaning": "Retained current Toast kitchen fulfillment and prep station facts; KDS permission and freshness must be verified.",
    "columns": {
      "business_id": {
        "meaning": "Authenticated café UUID; never query other cafés.",
        "unit": "UUID",
        "source": "app",
        "example": "What data does my café have?"
      },
      "source": {
        "meaning": "Data origin: Toast, owner, or application.",
        "unit": "label",
        "source": "app",
        "example": "Where did this number come from?"
      },
      "source_ref": {
        "meaning": "Reference to stored evidence, not a guest identity.",
        "unit": "identifier",
        "source": "app",
        "example": "Which record supports it?"
      },
      "status": {
        "meaning": "Actual, open or incomplete; capture-only is not live POS coverage.",
        "unit": "label",
        "source": "app",
        "example": "Is this record complete?"
      },
      "business_date": {
        "meaning": "Café local business date of the retained current Toast record, when supplied.",
        "unit": "local date",
        "source": "app",
        "example": "What happened on this date?"
      },
      "data": {
        "meaning": "Limited non-sensitive fields; no raw POS or customer payload.",
        "unit": "JSON",
        "source": "app",
        "example": "Show the provider detail."
      },
      "order_ref": {
        "meaning": "Toast order reference from fulfillment record.",
        "unit": "identifier",
        "source": "toast",
        "example": "What was recorded?"
      },
      "ticket_ref": {
        "meaning": "Kitchen ticket reference.",
        "unit": "identifier",
        "source": "toast",
        "example": "What was recorded?"
      },
      "fired_at": {
        "meaning": "Provider ticket-fired timestamp, when recorded.",
        "unit": "timestamp text",
        "source": "toast",
        "example": "What was recorded?"
      },
      "started_at": {
        "meaning": "Provider item-start timestamp, when recorded.",
        "unit": "timestamp text",
        "source": "toast",
        "example": "What was recorded?"
      },
      "ready_at": {
        "meaning": "Provider item-fulfilled timestamp, when recorded.",
        "unit": "timestamp text",
        "source": "toast",
        "example": "What was recorded?"
      },
      "prep_station_ref": {
        "meaning": "Provider prep station reference.",
        "unit": "identifier",
        "source": "toast",
        "example": "What was recorded?"
      }
    }
  },
  "cv_dining_options": {
    "meaning": "Retained current Toast dining-option configuration, not diagnostic captures; provider permissions and freshness may be incomplete.",
    "columns": {
      "business_id": {
        "meaning": "Authenticated café UUID; never query other cafés.",
        "unit": "UUID",
        "source": "app",
        "example": "What data does my café have?"
      },
      "source": {
        "meaning": "Data origin: Toast, owner, or application.",
        "unit": "label",
        "source": "app",
        "example": "Where did this number come from?"
      },
      "source_ref": {
        "meaning": "Reference to stored evidence, not a guest identity.",
        "unit": "identifier",
        "source": "app",
        "example": "Which record supports it?"
      },
      "status": {
        "meaning": "Actual, open or incomplete; capture-only is not live POS coverage.",
        "unit": "label",
        "source": "app",
        "example": "Is this record complete?"
      },
      "business_date": {
        "meaning": "Café local business date of the retained current Toast record, when supplied.",
        "unit": "local date",
        "source": "app",
        "example": "What happened on this date?"
      },
      "data": {
        "meaning": "Limited non-sensitive fields; no raw POS or customer payload.",
        "unit": "JSON",
        "source": "app",
        "example": "Show the provider detail."
      },
      "dining_option_ref": {
        "meaning": "Toast dining-option reference.",
        "unit": "identifier",
        "source": "toast",
        "example": "What was recorded?"
      },
      "dining_option_name": {
        "meaning": "Safe Toast dining-option label when supplied.",
        "unit": "label",
        "source": "toast",
        "example": "What was recorded?"
      }
    }
  },
  "cv_toast_records": {
    "meaning": "Count discount uses with record_type in (item_discount, check_discount) and counts_in_sales=true, grouped by data.name; count source_ref for uses, count_distinct order_ref for different orders, count_distinct check_ref for different checks. An order may have several checks and discount uses. Removed processingState VOID is retained but excluded. Today's closed orders are provisional and totals are incomplete until closeout. Every Toast record and field, one row each: orders, checks, items, modifiers, payments, discounts, service charges (latest import of each day; for today, before the closeout import, the closed orders saved so far with status provisional), plus retained current labor, cash, kitchen, menus and setup objects from authoritative stored Toast records, never diagnostic samples. Use it for anything the other views do not cover. Never use it to rebuild a screen number (net sales, profit, labor cost, card fees, break-even, item cost): use their tools.",
    "columns": {
      "business_id": {
        "meaning": "Authenticated café UUID; never query other cafés.",
        "unit": "UUID",
        "source": "app",
        "example": "What data does my café have?"
      },
      "source": {
        "meaning": "Always toast.",
        "unit": "label",
        "source": "app",
        "example": "Where did this come from?"
      },
      "source_ref": {
        "meaning": "Stable reference for this Toast record.",
        "unit": "identifier",
        "source": "app",
        "example": "Which record supports it?"
      },
      "status": {
        "meaning": "actual: imported evidence; provisional: current-day closed orders saved before closeout. A date range including the café's active business day is incomplete even if every returned row says actual; call it so far, not final.",
        "unit": "label",
        "source": "app",
        "example": "Is this final?"
      },
      "business_date": {
        "meaning": "Café business date; null for setup lists (menus, tables, discounts, jobs...), which always show the newest copy.",
        "unit": "local date",
        "source": "toast",
        "example": "What happened on this date?"
      },
      "record_type": {
        "meaning": "order, check, item, modifier, payment, check_discount, item_discount, service_charge, or a Toast endpoint such as labor/v1/timeEntries, labor/v1/employees, labor/v1/jobs, cashmgmt/v1/entries, config/v2/menuItems, config/v2/tables, menus/v2/menus, kitchen/v1/export/itemFulfillments. Always filter on it.",
        "unit": "label",
        "source": "toast",
        "example": "Which kind of record?"
      },
      "record_ref": {
        "meaning": "Toast GUID of this record.",
        "unit": "identifier",
        "source": "toast",
        "example": "Which record?"
      },
      "order_ref": {
        "meaning": "Toast order GUID for the order, check, item, discount and payment rows. Use count_distinct order_ref (not count of discount uses) for different orders; nulls are ignored.",
        "unit": "identifier",
        "source": "toast",
        "example": "Which order?"
      },
      "check_ref": {
        "meaning": "Toast check GUID for the check and its child records. Multiple checks may belong to one order; count_distinct check_ref is not the same as distinct orders.",
        "unit": "identifier",
        "source": "toast",
        "example": "Which check?"
      },
      "counts_in_sales": {
        "meaning": "Filter true for counting applied discounts: false for processingState VOID (removed), voided/deleted orders, checks or items, test-mode/excess-food orders, and excluded payments. Null for non-order records. Removed discounts are visible as evidence but never counted as uses.",
        "unit": "boolean",
        "source": "app",
        "example": "Did this count?"
      },
      "data": {
        "meaning": "Cleaned Toast fields: read named paths such as data.name, data.server.guid, data.price. Use describe_data with one record_type to discover paths. Numeric JSON fields support comparisons, sum, min, max and averages; is_null/is_not_null find absent fields without treating them as zero. Group by business_date and any named field for unplanned per-day/per-item questions. Group by data.name for discount names; status VOID is excluded with counts_in_sales, not by summing amounts. Toast JSON money fields are dollar-valued. For the fixture-proven amounts, use price_cents for item prices and discount_amount_cents for item/check discounts; both are integer cents. Neither is the screen net-sales definition. Unproven JSON dollar fields remain unprojected.",
        "unit": "JSON",
        "source": "toast",
        "example": "Sales by server? Average order time? Which table?"
      },
      "price_cents": {
        "meaning": "Toast item data.price projected to integer cents; null when absent or nonnumeric. Not net sales.",
        "unit": "cents",
        "source": "toast",
        "example": "What prices were recorded?"
      },
      "discount_amount_cents": {
        "meaning": "Toast item/check applied discount data.discountAmount projected to integer cents; filter counts_in_sales=true to exclude VOID uses.",
        "unit": "cents",
        "source": "toast",
        "example": "What discount amounts were recorded?"
      }
    }
  }
} as const;
export function isCanonicalView(name:string):name is CanonicalView {
 return (canonicalViewNames as readonly string[]).includes(name);
}
export function isCanonicalColumn(view:CanonicalView,column:string):boolean {
 return Object.prototype.hasOwnProperty.call(canonicalDictionary[view].columns,column)||
  isDataField(column)&&Object.prototype.hasOwnProperty.call(canonicalDictionary[view].columns,"data");
}
/** A named field inside a view's data JSON, e.g. "data.server.guid" or
 * "data.checks.0.amount". Matches the database rule in ai_query_path. */
// Never make payment credentials queryable just because an old retained
// source object contains an unexpected field. Person/staff/loyalty identity
// and ordinary provider GUIDs are allowed; these are reusable secrets only.
const FORBIDDEN_TOAST_FIELD=/^(?:pan|primaryAccountNumber|cardNumber|paymentCardNumber|cvv|cvc|cvv2|cvc2|cardVerificationValue|securityCode|magstripe|track|track1|track2|trackData|track1Data|track2Data|cardLast4|last4Digits|first5|first6|expiration|expiry|expireDate|cardExpiry|cardExpiration|password|passcode|pin|apiKey|secret|clientSecret|privateKey|accessToken|refreshToken|sessionToken|authToken|authorization|authorizationToken|paymentToken|cardToken|token|tokenId|fingerprint|networkTransactionIdentifier|routingNumber|bankAccountNumber|accountNumber|signature)$/i;
export function isDataField(column:string):boolean {
 return /^data(\.([A-Za-z_][A-Za-z0-9_]{0,100}|[0-9]{1,3})){1,16}$/.test(column) &&
  !column.slice(5).split(".").some(segment=>FORBIDDEN_TOAST_FIELD.test(segment)||
   /^(?:card|cardInfo|cardDetails|cardData|creditCard|paymentCard|giftCard|giftCardInfo|paymentMethod)$/i.test(segment));
}

// POS0e: Generated from the pinned official Toast Standard GET/2xx schema snapshot
// at docs/plans/toast-openapi-spec-snapshot.json (2026-11-08). This is a VERSIONED
// definition only: a listed field does NOT establish a café grant, live observation,
// retained value or permission to reveal another café's data. Credentials excluded.
export const toastOfficialFieldCatalog:Readonly<Record<string,{version:string;sha256:string;fields:[string,string[]][]}>>=
{"orders":{"version":"2.17.0","sha256":"087e880dd0accf0de46740d9cbcd65fa05f5df66db32b72fa0b74ddb54875093","fields":[["data.amount",["number"]],["data.amountTendered",["number"]],["data.appliedPackagingInfo",["object"]],["data.appliedPackagingInfo.appliedPackagingItems",["array"]],["data.appliedPackagingInfo.appliedPackagingItems.0",["object"]],["data.appliedPackagingInfo.appliedPackagingItems.0.entityType",["string"]],["data.appliedPackagingInfo.appliedPackagingItems.0.guestDisplayName",["string"]],["data.appliedPackagingInfo.appliedPackagingItems.0.guid",["string"]],["data.appliedPackagingInfo.appliedPackagingItems.0.inclusion",["string"]],["data.appliedPackagingInfo.appliedPackagingItems.0.itemConfigId",["string"]],["data.appliedPackagingInfo.appliedPackagingItems.0.itemTypes",["array"]],["data.appliedPackagingInfo.appliedPackagingItems.0.itemTypes.0",["string"]],["data.appliedPackagingInfo.entityType",["string"]],["data.appliedPackagingInfo.guid",["string"]],["data.approvalStatus",["string"]],["data.businessDate",["integer"]],["data.calculatedGuestCount",["number"]],["data.cardEntryMode",["string"]],["data.cardPaymentId",["string"]],["data.cardType",["string"]],["data.cashDrawer",["object"]],["data.cashDrawer.entityType",["string"]],["data.cashDrawer.externalId",["string"]],["data.cashDrawer.guid",["string"]],["data.channelGuid",["string"]],["data.checkGuid",["string"]],["data.checks",["array"]],["data.checks.0",["object"]],["data.checks.0.amount",["number"]],["data.checks.0.appliedDiscounts",["array"]],["data.checks.0.appliedDiscounts.0",["object"]],["data.checks.0.appliedDiscounts.0.appliedDiscountReason",["object"]],["data.checks.0.appliedDiscounts.0.appliedDiscountReason.comment",["string"]],["data.checks.0.appliedDiscounts.0.appliedDiscountReason.description",["string"]],["data.checks.0.appliedDiscounts.0.appliedDiscountReason.discountReason",["object"]],["data.checks.0.appliedDiscounts.0.appliedDiscountReason.discountReason.entityType",["string"]],["data.checks.0.appliedDiscounts.0.appliedDiscountReason.discountReason.guid",["string"]],["data.checks.0.appliedDiscounts.0.appliedDiscountReason.name",["string"]],["data.checks.0.appliedDiscounts.0.appliedPromoCode",["string"]],["data.checks.0.appliedDiscounts.0.approver",["object"]],["data.checks.0.appliedDiscounts.0.approver.entityType",["string"]],["data.checks.0.appliedDiscounts.0.approver.externalId",["string"]],["data.checks.0.appliedDiscounts.0.approver.guid",["string"]],["data.checks.0.appliedDiscounts.0.comboItems",["array"]],["data.checks.0.appliedDiscounts.0.comboItems.0",["object"]],["data.checks.0.appliedDiscounts.0.comboItems.0.entityType",["string"]],["data.checks.0.appliedDiscounts.0.comboItems.0.externalId",["string"]],["data.checks.0.appliedDiscounts.0.comboItems.0.guid",["string"]],["data.checks.0.appliedDiscounts.0.discount",["object"]],["data.checks.0.appliedDiscounts.0.discount.entityType",["string"]],["data.checks.0.appliedDiscounts.0.discount.guid",["string"]],["data.checks.0.appliedDiscounts.0.discountAmount",["number"]],["data.checks.0.appliedDiscounts.0.discountPercent",["number"]],["data.checks.0.appliedDiscounts.0.discountPlu",["string"]],["data.checks.0.appliedDiscounts.0.discountType",["string"]],["data.checks.0.appliedDiscounts.0.entityType",["string"]],["data.checks.0.appliedDiscounts.0.externalId",["string"]],["data.checks.0.appliedDiscounts.0.guid",["string"]],["data.checks.0.appliedDiscounts.0.loyaltyDetails",["object"]],["data.checks.0.appliedDiscounts.0.loyaltyDetails.referenceId",["string"]],["data.checks.0.appliedDiscounts.0.loyaltyDetails.vendor",["string"]],["data.checks.0.appliedDiscounts.0.name",["string"]],["data.checks.0.appliedDiscounts.0.nonTaxDiscountAmount",["number"]],["data.checks.0.appliedDiscounts.0.processingState",["string"]],["data.checks.0.appliedDiscounts.0.triggers",["array"]],["data.checks.0.appliedDiscounts.0.triggers.0",["object"]],["data.checks.0.appliedDiscounts.0.triggers.0.quantity",["number"]],["data.checks.0.appliedDiscounts.0.triggers.0.selection",["object"]],["data.checks.0.appliedDiscounts.0.triggers.0.selection.entityType",["string"]],["data.checks.0.appliedDiscounts.0.triggers.0.selection.externalId",["string"]],["data.checks.0.appliedDiscounts.0.triggers.0.selection.guid",["string"]],["data.checks.0.appliedLoyaltyInfo",["object"]],["data.checks.0.appliedLoyaltyInfo.accrualFamilyGuid",["string"]],["data.checks.0.appliedLoyaltyInfo.accrualText",["string"]],["data.checks.0.appliedLoyaltyInfo.entityType",["string"]],["data.checks.0.appliedLoyaltyInfo.guid",["string"]],["data.checks.0.appliedLoyaltyInfo.loyaltyIdentifier",["string"]],["data.checks.0.appliedLoyaltyInfo.maskedLoyaltyIdentifier",["string"]],["data.checks.0.appliedLoyaltyInfo.vendor",["string"]],["data.checks.0.appliedServiceCharges",["array"]],["data.checks.0.appliedServiceCharges.0",["object"]],["data.checks.0.appliedServiceCharges.0.appliedTaxes",["array"]],["data.checks.0.appliedServiceCharges.0.appliedTaxes.0",["object"]],["data.checks.0.appliedServiceCharges.0.appliedTaxes.0.displayName",["string"]],["data.checks.0.appliedServiceCharges.0.appliedTaxes.0.entityType",["string"]],["data.checks.0.appliedServiceCharges.0.appliedTaxes.0.facilitatorCollectAndRemitTax",["boolean"]],["data.checks.0.appliedServiceCharges.0.appliedTaxes.0.guid",["string"]],["data.checks.0.appliedServiceCharges.0.appliedTaxes.0.jurisdiction",["string"]],["data.checks.0.appliedServiceCharges.0.appliedTaxes.0.jurisdictionType",["string"]],["data.checks.0.appliedServiceCharges.0.appliedTaxes.0.name",["string"]],["data.checks.0.appliedServiceCharges.0.appliedTaxes.0.rate",["number"]],["data.checks.0.appliedServiceCharges.0.appliedTaxes.0.taxAmount",["number"]],["data.checks.0.appliedServiceCharges.0.appliedTaxes.0.taxRate",["object"]],["data.checks.0.appliedServiceCharges.0.appliedTaxes.0.taxRate.entityType",["string"]],["data.checks.0.appliedServiceCharges.0.appliedTaxes.0.taxRate.guid",["string"]],["data.checks.0.appliedServiceCharges.0.appliedTaxes.0.type",["string"]],["data.checks.0.appliedServiceCharges.0.chargeAmount",["number"]],["data.checks.0.appliedServiceCharges.0.chargeType",["string"]],["data.checks.0.appliedServiceCharges.0.delivery",["boolean"]],["data.checks.0.appliedServiceCharges.0.dineIn",["boolean"]],["data.checks.0.appliedServiceCharges.0.entityType",["string"]],["data.checks.0.appliedServiceCharges.0.externalId",["string"]],["data.checks.0.appliedServiceCharges.0.gratuity",["boolean"]],["data.checks.0.appliedServiceCharges.0.guid",["string"]],["data.checks.0.appliedServiceCharges.0.name",["string"]],["data.checks.0.appliedServiceCharges.0.paymentGuid",["string"]],["data.checks.0.appliedServiceCharges.0.refundDetails",["object"]],["data.checks.0.appliedServiceCharges.0.refundDetails.refundAmount",["number"]],["data.checks.0.appliedServiceCharges.0.refundDetails.refundTransaction",["object","unspecified"]],["data.checks.0.appliedServiceCharges.0.refundDetails.refundTransaction.entityType",["string"]],["data.checks.0.appliedServiceCharges.0.refundDetails.refundTransaction.guid",["string"]],["data.checks.0.appliedServiceCharges.0.refundDetails.taxRefundAmount",["number"]],["data.checks.0.appliedServiceCharges.0.serviceCharge",["object"]],["data.checks.0.appliedServiceCharges.0.serviceCharge.entityType",["string"]],["data.checks.0.appliedServiceCharges.0.serviceCharge.externalId",["string"]],["data.checks.0.appliedServiceCharges.0.serviceCharge.guid",["string"]],["data.checks.0.appliedServiceCharges.0.serviceChargeCalculation",["string"]],["data.checks.0.appliedServiceCharges.0.serviceChargeCategory",["string"]],["data.checks.0.appliedServiceCharges.0.takeout",["boolean"]],["data.checks.0.appliedServiceCharges.0.taxable",["boolean"]],["data.checks.0.closedDate",["string"]],["data.checks.0.createdByClientName",["string"]],["data.checks.0.createdDate",["string"]],["data.checks.0.createdDevice",["object"]],["data.checks.0.createdDevice.id",["string"]],["data.checks.0.customer",["object"]],["data.checks.0.customer.email",["string"]],["data.checks.0.customer.entityType",["string"]],["data.checks.0.customer.firstName",["string"]],["data.checks.0.customer.guid",["string"]],["data.checks.0.customer.lastName",["string"]],["data.checks.0.customer.phone",["string"]],["data.checks.0.customer.phoneCountryCode",["string"]],["data.checks.0.deleted",["boolean"]],["data.checks.0.deletedDate",["string"]],["data.checks.0.displayNumber",["string"]],["data.checks.0.duration",["integer"]],["data.checks.0.entityType",["string"]],["data.checks.0.externalId",["string"]],["data.checks.0.guid",["string"]],["data.checks.0.lastModifiedDevice",["object"]],["data.checks.0.lastModifiedDevice.id",["string"]],["data.checks.0.modifiedDate",["string"]],["data.checks.0.openedBy",["object"]],["data.checks.0.openedBy.entityType",["string"]],["data.checks.0.openedBy.externalId",["string"]],["data.checks.0.openedBy.guid",["string"]],["data.checks.0.openedDate",["string"]],["data.checks.0.paidDate",["string"]],["data.checks.0.payments",["array"]],["data.checks.0.payments.0",["object"]],["data.checks.0.payments.0.amount",["number"]],["data.checks.0.payments.0.amountTendered",["number"]],["data.checks.0.payments.0.cardEntryMode",["string"]],["data.checks.0.payments.0.cardPaymentId",["string"]],["data.checks.0.payments.0.cardType",["string"]],["data.checks.0.payments.0.cashDrawer",["object"]],["data.checks.0.payments.0.cashDrawer.entityType",["string"]],["data.checks.0.payments.0.cashDrawer.externalId",["string"]],["data.checks.0.payments.0.cashDrawer.guid",["string"]],["data.checks.0.payments.0.checkGuid",["string"]],["data.checks.0.payments.0.createdByClientName",["string"]],["data.checks.0.payments.0.createdDevice",["object"]],["data.checks.0.payments.0.createdDevice.id",["string"]],["data.checks.0.payments.0.entityType",["string"]],["data.checks.0.payments.0.externalId",["string"]],["data.checks.0.payments.0.first6Digits",["string"]],["data.checks.0.payments.0.guid",["string"]],["data.checks.0.payments.0.houseAccount",["object"]],["data.checks.0.payments.0.houseAccount.entityType",["string"]],["data.checks.0.payments.0.houseAccount.externalId",["string"]],["data.checks.0.payments.0.houseAccount.guid",["string"]],["data.checks.0.payments.0.last4Digits",["string"]],["data.checks.0.payments.0.lastModifiedDevice",["object"]],["data.checks.0.payments.0.lastModifiedDevice.id",["string"]],["data.checks.0.payments.0.mcaRepaymentAmount",["number"]],["data.checks.0.payments.0.networkTransactionIdentifier",["string"]],["data.checks.0.payments.0.orderGuid",["string"]],["data.checks.0.payments.0.originalProcessingFee",["number"]],["data.checks.0.payments.0.otherPayment",["object"]],["data.checks.0.payments.0.otherPayment.entityType",["string"]],["data.checks.0.payments.0.otherPayment.externalId",["string"]],["data.checks.0.payments.0.otherPayment.guid",["string"]],["data.checks.0.payments.0.paidBusinessDate",["integer"]],["data.checks.0.payments.0.paidDate",["string"]],["data.checks.0.payments.0.paymentStatus",["string"]],["data.checks.0.payments.0.refund",["object"]],["data.checks.0.payments.0.refund.refundAmount",["number"]],["data.checks.0.payments.0.refund.refundBusinessDate",["integer"]],["data.checks.0.payments.0.refund.refundDate",["string"]],["data.checks.0.payments.0.refund.refundTransaction",["object","unspecified"]],["data.checks.0.payments.0.refund.refundTransaction.entityType",["string"]],["data.checks.0.payments.0.refund.refundTransaction.guid",["string"]],["data.checks.0.payments.0.refund.tipRefundAmount",["number"]],["data.checks.0.payments.0.refundStatus",["string"]],["data.checks.0.payments.0.server",["object"]],["data.checks.0.payments.0.server.entityType",["string"]],["data.checks.0.payments.0.server.externalId",["string"]],["data.checks.0.payments.0.server.guid",["string"]],["data.checks.0.payments.0.tenderTransactionGuid",["string"]],["data.checks.0.payments.0.tipAmount",["number"]],["data.checks.0.payments.0.type",["string"]],["data.checks.0.payments.0.voidInfo",["object"]],["data.checks.0.payments.0.voidInfo.voidApprover",["object"]],["data.checks.0.payments.0.voidInfo.voidApprover.entityType",["string"]],["data.checks.0.payments.0.voidInfo.voidApprover.externalId",["string"]],["data.checks.0.payments.0.voidInfo.voidApprover.guid",["string"]],["data.checks.0.payments.0.voidInfo.voidBusinessDate",["integer"]],["data.checks.0.payments.0.voidInfo.voidDate",["string"]],["data.checks.0.payments.0.voidInfo.voidReason",["object"]],["data.checks.0.payments.0.voidInfo.voidReason.entityType",["string"]],["data.checks.0.payments.0.voidInfo.voidReason.externalId",["string"]],["data.checks.0.payments.0.voidInfo.voidReason.guid",["string"]],["data.checks.0.payments.0.voidInfo.voidUser",["object"]],["data.checks.0.payments.0.voidInfo.voidUser.entityType",["string"]],["data.checks.0.payments.0.voidInfo.voidUser.externalId",["string"]],["data.checks.0.payments.0.voidInfo.voidUser.guid",["string"]],["data.checks.0.paymentStatus",["string"]],["data.checks.0.selections",["array"]],["data.checks.0.selections.0",["object"]],["data.checks.0.selections.0.appliedDiscounts",["array"]],["data.checks.0.selections.0.appliedDiscounts.0",["object"]],["data.checks.0.selections.0.appliedDiscounts.0.appliedDiscountReason",["object"]],["data.checks.0.selections.0.appliedDiscounts.0.appliedDiscountReason.comment",["string"]],["data.checks.0.selections.0.appliedDiscounts.0.appliedDiscountReason.description",["string"]],["data.checks.0.selections.0.appliedDiscounts.0.appliedDiscountReason.discountReason",["object"]],["data.checks.0.selections.0.appliedDiscounts.0.appliedDiscountReason.discountReason.entityType",["string"]],["data.checks.0.selections.0.appliedDiscounts.0.appliedDiscountReason.discountReason.guid",["string"]],["data.checks.0.selections.0.appliedDiscounts.0.appliedDiscountReason.name",["string"]],["data.checks.0.selections.0.appliedDiscounts.0.appliedPromoCode",["string"]],["data.checks.0.selections.0.appliedDiscounts.0.approver",["object"]],["data.checks.0.selections.0.appliedDiscounts.0.approver.entityType",["string"]],["data.checks.0.selections.0.appliedDiscounts.0.approver.externalId",["string"]],["data.checks.0.selections.0.appliedDiscounts.0.approver.guid",["string"]],["data.checks.0.selections.0.appliedDiscounts.0.comboItems",["array"]],["data.checks.0.selections.0.appliedDiscounts.0.comboItems.0",["object"]],["data.checks.0.selections.0.appliedDiscounts.0.comboItems.0.entityType",["string"]],["data.checks.0.selections.0.appliedDiscounts.0.comboItems.0.externalId",["string"]],["data.checks.0.selections.0.appliedDiscounts.0.comboItems.0.guid",["string"]],["data.checks.0.selections.0.appliedDiscounts.0.discount",["object"]],["data.checks.0.selections.0.appliedDiscounts.0.discount.entityType",["string"]],["data.checks.0.selections.0.appliedDiscounts.0.discount.guid",["string"]],["data.checks.0.selections.0.appliedDiscounts.0.discountAmount",["number"]],["data.checks.0.selections.0.appliedDiscounts.0.discountPercent",["number"]],["data.checks.0.selections.0.appliedDiscounts.0.discountPlu",["string"]],["data.checks.0.selections.0.appliedDiscounts.0.discountType",["string"]],["data.checks.0.selections.0.appliedDiscounts.0.entityType",["string"]],["data.checks.0.selections.0.appliedDiscounts.0.externalId",["string"]],["data.checks.0.selections.0.appliedDiscounts.0.guid",["string"]],["data.checks.0.selections.0.appliedDiscounts.0.loyaltyDetails",["object"]],["data.checks.0.selections.0.appliedDiscounts.0.loyaltyDetails.referenceId",["string"]],["data.checks.0.selections.0.appliedDiscounts.0.loyaltyDetails.vendor",["string"]],["data.checks.0.selections.0.appliedDiscounts.0.name",["string"]],["data.checks.0.selections.0.appliedDiscounts.0.nonTaxDiscountAmount",["number"]],["data.checks.0.selections.0.appliedDiscounts.0.processingState",["string"]],["data.checks.0.selections.0.appliedDiscounts.0.triggers",["array"]],["data.checks.0.selections.0.appliedDiscounts.0.triggers.0",["object"]],["data.checks.0.selections.0.appliedDiscounts.0.triggers.0.quantity",["number"]],["data.checks.0.selections.0.appliedDiscounts.0.triggers.0.selection",["object"]],["data.checks.0.selections.0.appliedDiscounts.0.triggers.0.selection.entityType",["string"]],["data.checks.0.selections.0.appliedDiscounts.0.triggers.0.selection.externalId",["string"]],["data.checks.0.selections.0.appliedDiscounts.0.triggers.0.selection.guid",["string"]],["data.checks.0.selections.0.appliedTaxes",["array"]],["data.checks.0.selections.0.appliedTaxes.0",["object"]],["data.checks.0.selections.0.appliedTaxes.0.displayName",["string"]],["data.checks.0.selections.0.appliedTaxes.0.entityType",["string"]],["data.checks.0.selections.0.appliedTaxes.0.facilitatorCollectAndRemitTax",["boolean"]],["data.checks.0.selections.0.appliedTaxes.0.guid",["string"]],["data.checks.0.selections.0.appliedTaxes.0.jurisdiction",["string"]],["data.checks.0.selections.0.appliedTaxes.0.jurisdictionType",["string"]],["data.checks.0.selections.0.appliedTaxes.0.name",["string"]],["data.checks.0.selections.0.appliedTaxes.0.rate",["number"]],["data.checks.0.selections.0.appliedTaxes.0.taxAmount",["number"]],["data.checks.0.selections.0.appliedTaxes.0.taxRate",["object"]],["data.checks.0.selections.0.appliedTaxes.0.taxRate.entityType",["string"]],["data.checks.0.selections.0.appliedTaxes.0.taxRate.guid",["string"]],["data.checks.0.selections.0.appliedTaxes.0.type",["string"]],["data.checks.0.selections.0.createdByClientName",["string"]],["data.checks.0.selections.0.createdDate",["string"]],["data.checks.0.selections.0.deferred",["boolean"]],["data.checks.0.selections.0.diningOption",["object"]],["data.checks.0.selections.0.diningOption.entityType",["string"]],["data.checks.0.selections.0.diningOption.externalId",["string"]],["data.checks.0.selections.0.diningOption.guid",["string"]],["data.checks.0.selections.0.displayName",["string"]],["data.checks.0.selections.0.entityType",["string"]],["data.checks.0.selections.0.externalId",["string"]],["data.checks.0.selections.0.externalPriceAmount",["number"]],["data.checks.0.selections.0.fulfillment",["object"]],["data.checks.0.selections.0.fulfillment.quantity",["number"]],["data.checks.0.selections.0.fulfillment.unit",["string"]],["data.checks.0.selections.0.fulfillmentStatus",["string"]],["data.checks.0.selections.0.guestCountWeight",["number"]],["data.checks.0.selections.0.guid",["string"]],["data.checks.0.selections.0.item",["object"]],["data.checks.0.selections.0.item.entityType",["string"]],["data.checks.0.selections.0.item.externalId",["string"]],["data.checks.0.selections.0.item.guid",["string"]],["data.checks.0.selections.0.item.multiLocationId",["string"]],["data.checks.0.selections.0.itemGroup",["object"]],["data.checks.0.selections.0.itemGroup.entityType",["string"]],["data.checks.0.selections.0.itemGroup.externalId",["string"]],["data.checks.0.selections.0.itemGroup.guid",["string"]],["data.checks.0.selections.0.itemGroup.multiLocationId",["string"]],["data.checks.0.selections.0.modifiedDate",["string"]],["data.checks.0.selections.0.modifiers",["array"]],["data.checks.0.selections.0.modifiers.0",["recursive_ref"]],["data.checks.0.selections.0.openPriceAmount",["number"]],["data.checks.0.selections.0.optionGroup",["object"]],["data.checks.0.selections.0.optionGroup.entityType",["string"]],["data.checks.0.selections.0.optionGroup.externalId",["string"]],["data.checks.0.selections.0.optionGroup.guid",["string"]],["data.checks.0.selections.0.optionGroup.multiLocationId",["string"]],["data.checks.0.selections.0.optionGroupPricingMode",["string"]],["data.checks.0.selections.0.plu",["string"]],["data.checks.0.selections.0.preDiscountPrice",["number"]],["data.checks.0.selections.0.preModifier",["object"]],["data.checks.0.selections.0.preModifier.entityType",["string"]],["data.checks.0.selections.0.preModifier.externalId",["string"]],["data.checks.0.selections.0.preModifier.guid",["string"]],["data.checks.0.selections.0.preModifier.multiLocationId",["string"]],["data.checks.0.selections.0.premodifierPlu",["string"]],["data.checks.0.selections.0.price",["number"]],["data.checks.0.selections.0.quantity",["number"]],["data.checks.0.selections.0.receiptLinePrice",["number"]],["data.checks.0.selections.0.refundDetails",["object"]],["data.checks.0.selections.0.refundDetails.refundAmount",["number"]],["data.checks.0.selections.0.refundDetails.refundTransaction",["object","unspecified"]],["data.checks.0.selections.0.refundDetails.refundTransaction.entityType",["string"]],["data.checks.0.selections.0.refundDetails.refundTransaction.guid",["string"]],["data.checks.0.selections.0.refundDetails.taxRefundAmount",["number"]],["data.checks.0.selections.0.salesCategory",["object"]],["data.checks.0.selections.0.salesCategory.entityType",["string"]],["data.checks.0.selections.0.salesCategory.externalId",["string"]],["data.checks.0.selections.0.salesCategory.guid",["string"]],["data.checks.0.selections.0.salesCategory.multiLocationId",["string"]],["data.checks.0.selections.0.salesCategoryPlu",["string"]],["data.checks.0.selections.0.seatNumber",["integer"]],["data.checks.0.selections.0.selectionType",["string"]],["data.checks.0.selections.0.splitOrigin",["object"]],["data.checks.0.selections.0.splitOrigin.entityType",["string"]],["data.checks.0.selections.0.splitOrigin.externalId",["string"]],["data.checks.0.selections.0.splitOrigin.guid",["string"]],["data.checks.0.selections.0.tax",["number"]],["data.checks.0.selections.0.taxInclusion",["string"]],["data.checks.0.selections.0.unitOfMeasure",["string"]],["data.checks.0.selections.0.voidBusinessDate",["integer"]],["data.checks.0.selections.0.voidDate",["string"]],["data.checks.0.selections.0.voided",["boolean"]],["data.checks.0.selections.0.voidReason",["object"]],["data.checks.0.selections.0.voidReason.entityType",["string"]],["data.checks.0.selections.0.voidReason.externalId",["string"]],["data.checks.0.selections.0.voidReason.guid",["string"]],["data.checks.0.splitOrigin",["object"]],["data.checks.0.splitOrigin.entityType",["string"]],["data.checks.0.splitOrigin.externalId",["string"]],["data.checks.0.splitOrigin.guid",["string"]],["data.checks.0.tabName",["string"]],["data.checks.0.taxAmount",["number"]],["data.checks.0.taxExempt",["boolean"]],["data.checks.0.totalAmount",["number"]],["data.checks.0.voidBusinessDate",["integer"]],["data.checks.0.voidDate",["string"]],["data.checks.0.voided",["boolean"]],["data.closedDate",["string"]],["data.createdByClientName",["string"]],["data.createdDate",["string"]],["data.createdDevice",["object"]],["data.createdDevice.id",["string"]],["data.createdInTestMode",["boolean"]],["data.curbsidePickupInfo",["object"]],["data.curbsidePickupInfo.entityType",["string"]],["data.curbsidePickupInfo.guid",["string"]],["data.curbsidePickupInfo.notes",["string"]],["data.curbsidePickupInfo.transportColor",["string"]],["data.curbsidePickupInfo.transportDescription",["string"]],["data.deleted",["boolean"]],["data.deletedDate",["string"]],["data.deliveryInfo",["object"]],["data.deliveryInfo.address1",["string"]],["data.deliveryInfo.address2",["string"]],["data.deliveryInfo.administrativeArea",["string"]],["data.deliveryInfo.city",["string"]],["data.deliveryInfo.country",["string"]],["data.deliveryInfo.deliveredDate",["string"]],["data.deliveryInfo.deliveryEmployee",["object"]],["data.deliveryInfo.deliveryEmployee.entityType",["string"]],["data.deliveryInfo.deliveryEmployee.externalId",["string"]],["data.deliveryInfo.deliveryEmployee.guid",["string"]],["data.deliveryInfo.deliveryState",["string"]],["data.deliveryInfo.dispatchedDate",["string"]],["data.deliveryInfo.latitude",["number"]],["data.deliveryInfo.longitude",["number"]],["data.deliveryInfo.notes",["string"]],["data.deliveryInfo.state",["string"]],["data.deliveryInfo.zipCode",["string"]],["data.diningOption",["object"]],["data.diningOption.entityType",["string"]],["data.diningOption.externalId",["string"]],["data.diningOption.guid",["string"]],["data.displayNumber",["string"]],["data.duration",["integer"]],["data.entityType",["string"]],["data.estimatedFulfillmentDate",["string"]],["data.excessFood",["boolean"]],["data.externalId",["string"]],["data.first6Digits",["string"]],["data.guid",["string"]],["data.houseAccount",["object"]],["data.houseAccount.entityType",["string"]],["data.houseAccount.externalId",["string"]],["data.houseAccount.guid",["string"]],["data.last4Digits",["string"]],["data.lastModifiedDevice",["object"]],["data.lastModifiedDevice.id",["string"]],["data.marketplaceFacilitatorTaxInfo",["object"]],["data.marketplaceFacilitatorTaxInfo.facilitatorCollectAndRemitTaxOrder",["boolean"]],["data.marketplaceFacilitatorTaxInfo.taxes",["array"]],["data.marketplaceFacilitatorTaxInfo.taxes.0",["object"]],["data.marketplaceFacilitatorTaxInfo.taxes.0.displayName",["string"]],["data.marketplaceFacilitatorTaxInfo.taxes.0.entityType",["string"]],["data.marketplaceFacilitatorTaxInfo.taxes.0.facilitatorCollectAndRemitTax",["boolean"]],["data.marketplaceFacilitatorTaxInfo.taxes.0.guid",["string"]],["data.marketplaceFacilitatorTaxInfo.taxes.0.jurisdiction",["string"]],["data.marketplaceFacilitatorTaxInfo.taxes.0.jurisdictionType",["string"]],["data.marketplaceFacilitatorTaxInfo.taxes.0.name",["string"]],["data.marketplaceFacilitatorTaxInfo.taxes.0.rate",["number"]],["data.marketplaceFacilitatorTaxInfo.taxes.0.taxAmount",["number"]],["data.marketplaceFacilitatorTaxInfo.taxes.0.taxRate",["object"]],["data.marketplaceFacilitatorTaxInfo.taxes.0.taxRate.entityType",["string"]],["data.marketplaceFacilitatorTaxInfo.taxes.0.taxRate.guid",["string"]],["data.marketplaceFacilitatorTaxInfo.taxes.0.type",["string"]],["data.mcaRepaymentAmount",["number"]],["data.modifiedDate",["string"]],["data.networkTransactionIdentifier",["string"]],["data.numberOfGuests",["integer"]],["data.openedDate",["string"]],["data.orderGuid",["string"]],["data.originalProcessingFee",["number"]],["data.otherPayment",["object"]],["data.otherPayment.entityType",["string"]],["data.otherPayment.externalId",["string"]],["data.otherPayment.guid",["string"]],["data.paidBusinessDate",["integer"]],["data.paidDate",["string"]],["data.paymentStatus",["string"]],["data.pricingFeatures",["array"]],["data.pricingFeatures.0",["string"]],["data.promisedDate",["string"]],["data.refund",["object"]],["data.refund.refundAmount",["number"]],["data.refund.refundBusinessDate",["integer"]],["data.refund.refundDate",["string"]],["data.refund.refundTransaction",["object","unspecified"]],["data.refund.refundTransaction.entityType",["string"]],["data.refund.refundTransaction.guid",["string"]],["data.refund.tipRefundAmount",["number"]],["data.refundStatus",["string"]],["data.requiredPrepTime",["string"]],["data.restaurantService",["object"]],["data.restaurantService.entityType",["string"]],["data.restaurantService.externalId",["string"]],["data.restaurantService.guid",["string"]],["data.revenueCenter",["object"]],["data.revenueCenter.entityType",["string"]],["data.revenueCenter.externalId",["string"]],["data.revenueCenter.guid",["string"]],["data.server",["object"]],["data.server.entityType",["string"]],["data.server.externalId",["string"]],["data.server.guid",["string"]],["data.serviceArea",["object"]],["data.serviceArea.entityType",["string"]],["data.serviceArea.externalId",["string"]],["data.serviceArea.guid",["string"]],["data.source",["string"]],["data.table",["object"]],["data.table.entityType",["string"]],["data.table.externalId",["string"]],["data.table.guid",["string"]],["data.tenderTransactionGuid",["string"]],["data.thirdPartyProviderInfo",["object"]],["data.thirdPartyProviderInfo.entityType",["string"]],["data.thirdPartyProviderInfo.externalVoidReason",["string"]],["data.thirdPartyProviderInfo.guid",["string"]],["data.tipAmount",["number"]],["data.type",["string"]],["data.voidBusinessDate",["integer"]],["data.voidDate",["string"]],["data.voided",["boolean"]],["data.voidInfo",["object"]],["data.voidInfo.voidApprover",["object"]],["data.voidInfo.voidApprover.entityType",["string"]],["data.voidInfo.voidApprover.externalId",["string"]],["data.voidInfo.voidApprover.guid",["string"]],["data.voidInfo.voidBusinessDate",["integer"]],["data.voidInfo.voidDate",["string"]],["data.voidInfo.voidReason",["object"]],["data.voidInfo.voidReason.entityType",["string"]],["data.voidInfo.voidReason.externalId",["string"]],["data.voidInfo.voidReason.guid",["string"]],["data.voidInfo.voidUser",["object"]],["data.voidInfo.voidUser.entityType",["string"]],["data.voidInfo.voidUser.externalId",["string"]],["data.voidInfo.voidUser.guid",["string"]]]},"menus":{"version":"2.7.0","sha256":"433916ba7c303807a9e1e3856d09c783ed3427e2a6d8616726acc73aa4b1c696","fields":[["data.lastUpdated",["string"]],["data.menus",["array"]],["data.menus.0",["object"]],["data.menus.0.availability",["object"]],["data.menus.0.availability.0",["object"]],["data.menus.0.availability.0.alwaysAvailable",["boolean"]],["data.menus.0.availability.0.schedule",["array"]],["data.menus.0.availability.0.schedule.0",["object"]],["data.menus.0.availability.0.schedule.0.days",["array"]],["data.menus.0.availability.0.schedule.0.days.0",["string"]],["data.menus.0.availability.0.schedule.0.timeRanges",["array"]],["data.menus.0.availability.0.schedule.0.timeRanges.0",["object"]],["data.menus.0.availability.0.schedule.0.timeRanges.0.end",["string"]],["data.menus.0.availability.0.schedule.0.timeRanges.0.start",["string"]],["data.menus.0.description",["string"]],["data.menus.0.guid",["string"]],["data.menus.0.highResImage",["string"]],["data.menus.0.image",["string"]],["data.menus.0.masterId",["integer"]],["data.menus.0.menuGroups",["array"]],["data.menus.0.menuGroups.0",["object"]],["data.menus.0.menuGroups.0.combos",["array"]],["data.menus.0.menuGroups.0.combos.0",["object"]],["data.menus.0.menuGroups.0.description",["string"]],["data.menus.0.menuGroups.0.guid",["string"]],["data.menus.0.menuGroups.0.image",["string"]],["data.menus.0.menuGroups.0.itemTags",["array"]],["data.menus.0.menuGroups.0.itemTags.0",["object"]],["data.menus.0.menuGroups.0.itemTags.0.guid",["string"]],["data.menus.0.menuGroups.0.itemTags.0.name",["string"]],["data.menus.0.menuGroups.0.masterId",["integer"]],["data.menus.0.menuGroups.0.menuGroups",["array"]],["data.menus.0.menuGroups.0.menuGroups.0",["recursive_ref"]],["data.menus.0.menuGroups.0.menuItems",["array"]],["data.menus.0.menuGroups.0.menuItems.0",["object"]],["data.menus.0.menuGroups.0.menuItems.0.allergens",["array"]],["data.menus.0.menuGroups.0.menuItems.0.allergens.0",["object"]],["data.menus.0.menuGroups.0.menuItems.0.allergens.0.code",["string"]],["data.menus.0.menuGroups.0.menuItems.0.allergens.0.groupCode",["string"]],["data.menus.0.menuGroups.0.menuItems.0.allergens.0.groupGuid",["string"]],["data.menus.0.menuGroups.0.menuItems.0.allergens.0.guid",["string"]],["data.menus.0.menuGroups.0.menuItems.0.allergens.0.presenceType",["string"]],["data.menus.0.menuGroups.0.menuItems.0.calories",["integer"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo",["object"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.brand",["object"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.brand.id",["string"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.brand.name",["string"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.customAttributes",["array"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.customAttributes.0",["object"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.customAttributes.0.id",["string"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.customAttributes.0.name",["string"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.customAttributes.0.type",["string"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.customAttributes.0.values",["array"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.customAttributes.0.values.0",["object"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.customAttributes.0.values.0.id",["string"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.customAttributes.0.values.0.name",["string"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.product",["object"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.product.availableOptions",["array"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.product.availableOptions.0",["object"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.product.availableOptions.0.id",["string"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.product.availableOptions.0.name",["string"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.product.availableOptions.0.sortOrder",["integer"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.product.availableOptions.0.values",["array"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.product.availableOptions.0.values.0",["object"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.product.availableOptions.0.values.0.id",["string"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.product.availableOptions.0.values.0.name",["string"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.product.availableOptions.0.values.0.sortOrder",["integer"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.product.description",["string"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.product.id",["string"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.product.images",["array"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.product.images.0",["string"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.product.name",["string"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.product.type",["string"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.productVariant",["object"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.productVariant.description",["string"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.productVariant.id",["string"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.productVariant.name",["string"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.productVariant.selectedOptions",["array"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.productVariant.selectedOptions.0",["object"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.productVariant.selectedOptions.0.id",["string"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.productVariant.selectedOptions.0.name",["string"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.productVariant.selectedOptions.0.sortOrder",["integer"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.productVariant.selectedOptions.0.value",["object"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.productVariant.selectedOptions.0.value.id",["string"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.productVariant.selectedOptions.0.value.name",["string"]],["data.menus.0.menuGroups.0.menuItems.0.catalogProductInfo.productVariant.selectedOptions.0.value.sortOrder",["integer"]],["data.menus.0.menuGroups.0.menuItems.0.contentAdvisories",["object"]],["data.menus.0.menuGroups.0.menuItems.0.contentAdvisories.alcohol",["object"]],["data.menus.0.menuGroups.0.menuItems.0.contentAdvisories.alcohol.containsAlcohol",["string"]],["data.menus.0.menuGroups.0.menuItems.0.defaultModifiersFirst",["boolean"]],["data.menus.0.menuGroups.0.menuItems.0.description",["string"]],["data.menus.0.menuGroups.0.menuItems.0.dimensionUnitOfMeasure",["string"]],["data.menus.0.menuGroups.0.menuItems.0.eligiblePaymentAssistancePrograms",["array"]],["data.menus.0.menuGroups.0.menuItems.0.eligiblePaymentAssistancePrograms.0",["string"]],["data.menus.0.menuGroups.0.menuItems.0.guestCount",["number"]],["data.menus.0.menuGroups.0.menuItems.0.guid",["string"]],["data.menus.0.menuGroups.0.menuItems.0.height",["number"]],["data.menus.0.menuGroups.0.menuItems.0.image",["string"]],["data.menus.0.menuGroups.0.menuItems.0.images",["array"]],["data.menus.0.menuGroups.0.menuItems.0.images.0",["string"]],["data.menus.0.menuGroups.0.menuItems.0.isComboParent",["boolean"]],["data.menus.0.menuGroups.0.menuItems.0.isDeferred",["boolean"]],["data.menus.0.menuGroups.0.menuItems.0.isDiscountable",["boolean"]],["data.menus.0.menuGroups.0.menuItems.0.itemTags",["array"]],["data.menus.0.menuGroups.0.menuItems.0.itemTags.0",["object"]],["data.menus.0.menuGroups.0.menuItems.0.itemTags.0.guid",["string"]],["data.menus.0.menuGroups.0.menuItems.0.itemTags.0.name",["string"]],["data.menus.0.menuGroups.0.menuItems.0.kitchenName",["string"]],["data.menus.0.menuGroups.0.menuItems.0.length",["number"]],["data.menus.0.menuGroups.0.menuItems.0.masterId",["integer"]],["data.menus.0.menuGroups.0.menuItems.0.modifierGroupReferences",["array"]],["data.menus.0.menuGroups.0.menuItems.0.modifierGroupReferences.0",["integer"]],["data.menus.0.menuGroups.0.menuItems.0.multiLocationId",["string"]],["data.menus.0.menuGroups.0.menuItems.0.name",["string"]],["data.menus.0.menuGroups.0.menuItems.0.plu",["string"]],["data.menus.0.menuGroups.0.menuItems.0.portions",["array"]],["data.menus.0.menuGroups.0.menuItems.0.portions.0",["object"]],["data.menus.0.menuGroups.0.menuItems.0.portions.0.guid",["string"]],["data.menus.0.menuGroups.0.menuItems.0.portions.0.modifierGroupReferences",["array"]],["data.menus.0.menuGroups.0.menuItems.0.portions.0.modifierGroupReferences.0",["integer"]],["data.menus.0.menuGroups.0.menuItems.0.portions.0.name",["string"]],["data.menus.0.menuGroups.0.menuItems.0.portions.0.priceScaleFactor",["number"]],["data.menus.0.menuGroups.0.menuItems.0.posButtonColorDark",["string"]],["data.menus.0.menuGroups.0.menuItems.0.posButtonColorLight",["string"]],["data.menus.0.menuGroups.0.menuItems.0.posName",["string"]],["data.menus.0.menuGroups.0.menuItems.0.prepStations",["array"]],["data.menus.0.menuGroups.0.menuItems.0.prepStations.0",["string"]],["data.menus.0.menuGroups.0.menuItems.0.prepTime",["integer"]],["data.menus.0.menuGroups.0.menuItems.0.price",["number"]],["data.menus.0.menuGroups.0.menuItems.0.pricingRules",["object"]],["data.menus.0.menuGroups.0.menuItems.0.pricingRules.0",["object"]],["data.menus.0.menuGroups.0.menuItems.0.pricingRules.0.sizeSequencePricingRules",["array"]],["data.menus.0.menuGroups.0.menuItems.0.pricingRules.0.sizeSequencePricingRules.0",["object"]],["data.menus.0.menuGroups.0.menuItems.0.pricingRules.0.sizeSequencePricingRules.0.sequencePrices",["array"]],["data.menus.0.menuGroups.0.menuItems.0.pricingRules.0.sizeSequencePricingRules.0.sequencePrices.0",["object"]],["data.menus.0.menuGroups.0.menuItems.0.pricingRules.0.sizeSequencePricingRules.0.sequencePrices.0.price",["number"]],["data.menus.0.menuGroups.0.menuItems.0.pricingRules.0.sizeSequencePricingRules.0.sequencePrices.0.sequence",["integer"]],["data.menus.0.menuGroups.0.menuItems.0.pricingRules.0.sizeSequencePricingRules.0.sizeGuid",["string"]],["data.menus.0.menuGroups.0.menuItems.0.pricingRules.0.sizeSequencePricingRules.0.sizeName",["string"]],["data.menus.0.menuGroups.0.menuItems.0.pricingRules.0.sizeSpecificPricingGuid",["string"]],["data.menus.0.menuGroups.0.menuItems.0.pricingRules.0.timeSpecificPricingRules",["array"]],["data.menus.0.menuGroups.0.menuItems.0.pricingRules.0.timeSpecificPricingRules.0",["object"]],["data.menus.0.menuGroups.0.menuItems.0.pricingRules.0.timeSpecificPricingRules.0.basePrice",["number"]],["data.menus.0.menuGroups.0.menuItems.0.pricingRules.0.timeSpecificPricingRules.0.schedule",["array"]],["data.menus.0.menuGroups.0.menuItems.0.pricingRules.0.timeSpecificPricingRules.0.schedule.0",["object"]],["data.menus.0.menuGroups.0.menuItems.0.pricingRules.0.timeSpecificPricingRules.0.schedule.0.days",["array"]],["data.menus.0.menuGroups.0.menuItems.0.pricingRules.0.timeSpecificPricingRules.0.schedule.0.days.0",["string"]],["data.menus.0.menuGroups.0.menuItems.0.pricingRules.0.timeSpecificPricingRules.0.schedule.0.timeRanges",["array"]],["data.menus.0.menuGroups.0.menuItems.0.pricingRules.0.timeSpecificPricingRules.0.schedule.0.timeRanges.0",["object"]],["data.menus.0.menuGroups.0.menuItems.0.pricingRules.0.timeSpecificPricingRules.0.schedule.0.timeRanges.0.end",["string"]],["data.menus.0.menuGroups.0.menuItems.0.pricingRules.0.timeSpecificPricingRules.0.schedule.0.timeRanges.0.start",["string"]],["data.menus.0.menuGroups.0.menuItems.0.pricingRules.0.timeSpecificPricingRules.0.timeSpecificPrice",["number"]],["data.menus.0.menuGroups.0.menuItems.0.pricingStrategy",["string"]],["data.menus.0.menuGroups.0.menuItems.0.salesCategory",["object"]],["data.menus.0.menuGroups.0.menuItems.0.salesCategory.guid",["string"]],["data.menus.0.menuGroups.0.menuItems.0.salesCategory.name",["string"]],["data.menus.0.menuGroups.0.menuItems.0.salesCategory.plu",["string"]],["data.menus.0.menuGroups.0.menuItems.0.sku",["string"]],["data.menus.0.menuGroups.0.menuItems.0.sortOrder",["integer"]],["data.menus.0.menuGroups.0.menuItems.0.taxInclusion",["string"]],["data.menus.0.menuGroups.0.menuItems.0.taxInfo",["array"]],["data.menus.0.menuGroups.0.menuItems.0.taxInfo.0",["string"]],["data.menus.0.menuGroups.0.menuItems.0.unitOfMeasure",["string"]],["data.menus.0.menuGroups.0.menuItems.0.visibility",["array"]],["data.menus.0.menuGroups.0.menuItems.0.visibility.0",["string"]],["data.menus.0.menuGroups.0.menuItems.0.weight",["number"]],["data.menus.0.menuGroups.0.menuItems.0.weightUnitOfMeasure",["string"]],["data.menus.0.menuGroups.0.menuItems.0.width",["number"]],["data.menus.0.menuGroups.0.multiLocationId",["string"]],["data.menus.0.menuGroups.0.name",["string"]],["data.menus.0.menuGroups.0.posButtonColorDark",["string"]],["data.menus.0.menuGroups.0.posButtonColorLight",["string"]],["data.menus.0.menuGroups.0.posName",["string"]],["data.menus.0.menuGroups.0.visibility",["array"]],["data.menus.0.menuGroups.0.visibility.0",["string"]],["data.menus.0.multiLocationId",["string"]],["data.menus.0.name",["string"]],["data.menus.0.posButtonColorDark",["string"]],["data.menus.0.posButtonColorLight",["string"]],["data.menus.0.posName",["string"]],["data.menus.0.visibility",["array"]],["data.menus.0.visibility.0",["string"]],["data.modifierGroupReferences",["object"]],["data.modifierGroupReferences.identifier",["integer"]],["data.modifierOptionReferences",["object"]],["data.modifierOptionReferences.identifier",["integer"]],["data.preModifierGroupReferences",["object"]],["data.preModifierGroupReferences.identifier",["integer"]],["data.restaurantGuid",["string"]],["data.restaurantTimeZone",["string"]]]},"config":{"version":"2.5.0","sha256":"a232692e4a21af1afa591492dedb06d44ccf1fd063a9b090d0e7e343ad39b22a","fields":[["data.active",["boolean"]],["data.amount",["number"]],["data.amountType",["string"]],["data.applicableTaxes",["array"]],["data.applicableTaxes.0",["object"]],["data.applicableTaxes.0.conditionalTaxRates",["array"]],["data.applicableTaxes.0.conditionalTaxRates.0",["object"]],["data.applicableTaxes.0.conditionalTaxRates.0.condition",["string"]],["data.applicableTaxes.0.conditionalTaxRates.0.rate",["number"]],["data.applicableTaxes.0.entityType",["string"]],["data.applicableTaxes.0.guid",["string"]],["data.applicableTaxes.0.isDefault",["boolean"]],["data.applicableTaxes.0.name",["string"]],["data.applicableTaxes.0.rate",["number"]],["data.applicableTaxes.0.roundingType",["string"]],["data.applicableTaxes.0.taxTable",["array"]],["data.applicableTaxes.0.taxTable.0",["object"]],["data.applicableTaxes.0.taxTable.0.end",["number"]],["data.applicableTaxes.0.taxTable.0.pattern",["boolean"]],["data.applicableTaxes.0.taxTable.0.start",["number"]],["data.applicableTaxes.0.taxTable.0.tax",["number"]],["data.applicableTaxes.0.type",["string"]],["data.basePrice",["number"]],["data.behavior",["string"]],["data.breakIntervalHrs",["integer"]],["data.breakIntervalMins",["integer"]],["data.calories",["integer"]],["data.chargeAsExtra",["boolean"]],["data.conditionalTaxRates",["array"]],["data.conditionalTaxRates.0",["object"]],["data.conditionalTaxRates.0.condition",["string"]],["data.conditionalTaxRates.0.rate",["number"]],["data.criteria",["object"]],["data.criteria.delivery",["boolean"]],["data.criteria.dineIn",["boolean"]],["data.criteria.maxCheckAmount",["number"]],["data.criteria.minCheckAmount",["number"]],["data.criteria.minDeliveryDistance",["number"]],["data.criteria.takeout",["boolean"]],["data.curbside",["boolean"]],["data.description",["string"]],["data.destination",["string"]],["data.displayMode",["string"]],["data.driveThru",["boolean"]],["data.duration",["integer"]],["data.enabled",["boolean"]],["data.enforceMinimumTime",["boolean"]],["data.entityType",["string"]],["data.externalId",["string"]],["data.fixedTotal",["number"]],["data.gratuity",["boolean"]],["data.groups",["array"]],["data.groups.0",["object"]],["data.groups.0.entityType",["string"]],["data.groups.0.externalId",["string"]],["data.groups.0.guid",["string"]],["data.guid",["string"]],["data.images",["array"]],["data.images.0",["object"]],["data.images.0.url",["string"]],["data.inheritOptionGroups",["boolean"]],["data.inheritUnitOfMeasure",["boolean"]],["data.isDefault",["boolean"]],["data.itemPickingPriority",["string"]],["data.items",["array"]],["data.items.0",["object"]],["data.items.0.entityType",["string"]],["data.items.0.externalId",["string"]],["data.items.0.guid",["string"]],["data.maxSelections",["number"]],["data.menu",["object"]],["data.menu.entityType",["string"]],["data.menu.externalId",["string"]],["data.menu.guid",["string"]],["data.minSelections",["number"]],["data.name",["string"]],["data.nonExclusive",["boolean"]],["data.optionGroups",["array"]],["data.optionGroups.0",["object"]],["data.optionGroups.0.entityType",["string"]],["data.optionGroups.0.externalId",["string"]],["data.optionGroups.0.guid",["string"]],["data.options",["array"]],["data.options.0",["object"]],["data.options.0.entityType",["string"]],["data.options.0.externalId",["string"]],["data.options.0.guid",["string"]],["data.orderableOnline",["string"]],["data.paid",["boolean"]],["data.parent",["object"]],["data.parent.entityType",["string"]],["data.parent.externalId",["string"]],["data.parent.guid",["string"]],["data.percent",["number"]],["data.percentage",["number"]],["data.plu",["string"]],["data.printer",["object"]],["data.printer.entityType",["string"]],["data.printer.guid",["string"]],["data.promoCodes",["array"]],["data.promoCodes.0",["object"]],["data.promoCodes.0.code",["string"]],["data.promoCodes.0.entityType",["string"]],["data.promoCodes.0.guid",["string"]],["data.promoCodes.0.name",["string"]],["data.promoCodes.0.usageType",["string"]],["data.rate",["number"]],["data.revenueCenter",["object"]],["data.revenueCenter.entityType",["string"]],["data.revenueCenter.externalId",["string"]],["data.revenueCenter.guid",["string"]],["data.roundingType",["string"]],["data.scaleFactor",["number"]],["data.scalePrice",["boolean"]],["data.selectionType",["string"]],["data.serviceArea",["object"]],["data.serviceArea.entityType",["string"]],["data.serviceArea.guid",["string"]],["data.serviceAreaType",["string"]],["data.serviceChargeCalculation",["string"]],["data.sku",["string"]],["data.subgroups",["array"]],["data.subgroups.0",["object"]],["data.subgroups.0.entityType",["string"]],["data.subgroups.0.externalId",["string"]],["data.subgroups.0.guid",["string"]],["data.taxable",["boolean"]],["data.taxInclusive",["boolean"]],["data.taxProrated",["boolean"]],["data.taxTable",["array"]],["data.taxTable.0",["object"]],["data.taxTable.0.end",["number"]],["data.taxTable.0.pattern",["boolean"]],["data.taxTable.0.start",["number"]],["data.taxTable.0.tax",["number"]],["data.trackBreakAcknowledgement",["boolean"]],["data.trackMissedBreaks",["boolean"]],["data.type",["string"]],["data.unitOfMeasure",["string"]],["data.visibility",["string"]]]},"labor":{"version":"1.9.0","sha256":"45c2ce1a797297e1a0772270667ab9803e28592e05e18c7a3046f02feca46a92","fields":[["data.autoClockedOut",["boolean"]],["data.breaks",["array"]],["data.breaks.0",["object"]],["data.breaks.0.auditResponse",["boolean"]],["data.breaks.0.breakType",["object"]],["data.breaks.0.breakType.entityType",["string"]],["data.breaks.0.breakType.guid",["string"]],["data.breaks.0.guid",["string"]],["data.breaks.0.inDate",["string"]],["data.breaks.0.missed",["boolean"]],["data.breaks.0.outDate",["string"]],["data.breaks.0.paid",["boolean"]],["data.breaks.0.waived",["boolean"]],["data.businessDate",["string"]],["data.cashGratuityServiceCharges",["number"]],["data.cashSales",["number"]],["data.chosenName",["string"]],["data.code",["string"]],["data.createdDate",["string"]],["data.declaredCashTips",["number"]],["data.defaultWage",["number"]],["data.deleted",["boolean"]],["data.deletedDate",["string"]],["data.email",["string"]],["data.employeeReference",["object"]],["data.employeeReference.entityType",["string"]],["data.employeeReference.externalId",["string"]],["data.employeeReference.guid",["string"]],["data.entityType",["string"]],["data.excludeFromReporting",["boolean"]],["data.externalEmployeeId",["string"]],["data.externalId",["string"]],["data.firstName",["string"]],["data.guid",["string"]],["data.hourlyWage",["number"]],["data.inDate",["string"]],["data.jobReference",["object"]],["data.jobReference.entityType",["string"]],["data.jobReference.externalId",["string"]],["data.jobReference.guid",["string"]],["data.jobReferences",["array"]],["data.jobReferences.0",["object"]],["data.jobReferences.0.entityType",["string"]],["data.jobReferences.0.externalId",["string"]],["data.jobReferences.0.guid",["string"]],["data.lastName",["string"]],["data.modifiedDate",["string"]],["data.nonCashGratuityServiceCharges",["number"]],["data.nonCashSales",["number"]],["data.nonCashTips",["number"]],["data.nonCashTipsRoundingLoss",["number"]],["data.outDate",["string"]],["data.overtimeHours",["number"]],["data.passcode",["string"]],["data.phoneNumber",["string"]],["data.phoneNumberCountryCode",["string"]],["data.regularHours",["number"]],["data.scheduleConfig",["object"]],["data.scheduleConfig.guid",["string"]],["data.scheduleConfig.minAfterClockIn",["number"]],["data.scheduleConfig.minAfterClockOut",["number"]],["data.scheduleConfig.minBeforeClockIn",["number"]],["data.scheduleConfig.minBeforeClockOut",["number"]],["data.shiftReference",["object"]],["data.shiftReference.entityType",["string"]],["data.shiftReference.externalId",["string"]],["data.shiftReference.guid",["string"]],["data.tipped",["boolean"]],["data.tipsWithheld",["number"]],["data.title",["string"]],["data.v2EmployeeGuid",["string"]],["data.wageFrequency",["string"]],["data.wageOverrides",["array"]],["data.wageOverrides.0",["object"]],["data.wageOverrides.0.jobReference",["object"]],["data.wageOverrides.0.jobReference.entityType",["string"]],["data.wageOverrides.0.jobReference.externalId",["string"]],["data.wageOverrides.0.jobReference.guid",["string"]],["data.wageOverrides.0.wage",["number"]]]},"cashmgmt":{"version":"1.1.0","sha256":"4f54b9b9cd2d2b9233762a8bc3d7b66a6a87707d5c4ecda88890c4761e50c48b","fields":[["data.amount",["number"]],["data.approverOrShiftReviewSubject",["object"]],["data.approverOrShiftReviewSubject.entityType",["string"]],["data.approverOrShiftReviewSubject.guid",["string"]],["data.cashDrawer",["object"]],["data.cashDrawer.entityType",["string"]],["data.cashDrawer.guid",["string"]],["data.creator",["object"]],["data.creator.entityType",["string"]],["data.creator.guid",["string"]],["data.creatorOrShiftReviewSubject",["object"]],["data.creatorOrShiftReviewSubject.entityType",["string"]],["data.creatorOrShiftReviewSubject.guid",["string"]],["data.date",["string"]],["data.employee",["object"]],["data.employee.entityType",["string"]],["data.employee.externalId",["string"]],["data.employee.guid",["string"]],["data.employee1",["object"]],["data.employee1.entityType",["string"]],["data.employee1.externalId",["string"]],["data.employee1.guid",["string"]],["data.employee2",["object"]],["data.employee2.entityType",["string"]],["data.employee2.externalId",["string"]],["data.employee2.guid",["string"]],["data.entityType",["string"]],["data.guid",["string"]],["data.noSaleReason",["object"]],["data.noSaleReason.entityType",["string"]],["data.noSaleReason.guid",["string"]],["data.payoutReason",["object"]],["data.payoutReason.entityType",["string"]],["data.payoutReason.guid",["string"]],["data.reason",["string"]],["data.type",["string"]],["data.undoes",["string"]]]},"stock":{"version":"1.0.0","sha256":"fc85052d201940a1faae8c383cb97335542b3d8604e63cba8263d6ffc7cb335b","fields":[["data.guid",["string"]],["data.itemGuidValidity",["string"]],["data.multiLocationId",["string"]],["data.quantity",["number"]],["data.status",["string"]],["data.versionId",["string"]]]},"kitchen":{"version":"1.0.2","sha256":"4726fcf6d4b89c723fe5e2b42514c83589d1dd6caf0b6fb35fcbf366890f6279","fields":[["data.connectedPrepStations",["array"]],["data.connectedPrepStations.0",["object"]],["data.connectedPrepStations.0.entityType",["string"]],["data.connectedPrepStations.0.guid",["string"]],["data.courseGuid",["string"]],["data.courseName",["string"]],["data.diningOptionBehavior",["string"]],["data.diningOptionGuid",["string"]],["data.diningOptionName",["string"]],["data.entityType",["string"]],["data.expoRouting",["string"]],["data.guid",["string"]],["data.includeWithExpediter",["boolean"]],["data.itemFulfilledAt",["string"]],["data.itemFulfillmentLevel",["integer"]],["data.itemStartedAt",["string"]],["data.kitchenPrinter",["object"]],["data.kitchenPrinter.entityType",["string"]],["data.kitchenPrinter.guid",["string"]],["data.name",["string"]],["data.orderGuid",["string"]],["data.orderSource",["string"]],["data.prepStationGuid",["string"]],["data.prepStationMultiLocationId",["string"]],["data.prepStationName",["string"]],["data.printingMode",["string"]],["data.restaurantGuid",["string"]],["data.selectionGuid",["string"]],["data.selectionMenuItemGuid",["string"]],["data.selectionMenuItemMultiLocationId",["string"]],["data.selectionMenuItemName",["string"]],["data.ticketFiredAt",["string"]],["data.ticketGuid",["string"]]]},"packaging":{"version":"1.0.0","sha256":"140e4e9f38d3d9f603d900a997615cd22c6a2e6611e73305f3ebc13c5fa8e658","fields":[["data.enabled",["boolean"]],["data.guestMessage",["string"]],["data.items",["array"]],["data.items.0",["object"]],["data.items.0.guestDescription",["string"]],["data.items.0.guestDisplayName",["string"]],["data.items.0.guestInclusionType",["string"]],["data.items.0.id",["string"]],["data.items.0.itemTypes",["array"]],["data.items.0.itemTypes.0",["string"]]]},"restaurant-availability":{"version":"1.0.1","sha256":"0440fc07d569af0fe3c0d12e7ef820483a42e41ffafac585e0a408d574d95901","fields":[["data.reason",["string"]],["data.reasonKey",["string"]],["data.restaurantGuid",["string"]],["data.status",["string"]]]},"ordermgmt-config":{"version":"1.0.1","sha256":"49afd5ee3fb64c9eac90df45c1d3336f34b40fda7c589de1fb3e41f789d57780","fields":[["data.acceptScheduledOrders",["boolean"]],["data.lastOrderConfiguration",["string"]],["data.overrides",["array"]],["data.overrides.0",["object"]],["data.overrides.0.businessDate",["integer"]],["data.overrides.0.description",["string"]],["data.overrides.0.diningOptionBehavior",["array"]],["data.overrides.0.diningOptionBehavior.0",["string"]],["data.overrides.0.timeRanges",["array"]],["data.overrides.0.timeRanges.0",["object"]],["data.overrides.0.timeRanges.0.end",["string"]],["data.overrides.0.timeRanges.0.start",["string"]],["data.scheduledOrderMaxDays",["integer"]],["data.servicePeriods",["array"]],["data.servicePeriods.0",["object"]],["data.servicePeriods.0.dayPeriods",["array"]],["data.servicePeriods.0.dayPeriods.0",["object"]],["data.servicePeriods.0.dayPeriods.0.day",["string"]],["data.servicePeriods.0.dayPeriods.0.timeRanges",["array"]],["data.servicePeriods.0.dayPeriods.0.timeRanges.0",["object"]],["data.servicePeriods.0.dayPeriods.0.timeRanges.0.end",["string"]],["data.servicePeriods.0.dayPeriods.0.timeRanges.0.start",["string"]],["data.servicePeriods.0.diningOptionBehavior",["string"]],["data.timeZoneId",["string"]]]},"device-details":{"version":"1.0.0","sha256":"a704e76a9ca4b31751b8c9f837f7a9a381e6c4bd3fc157c2b29f41e695d58e52","fields":[["data.deviceModel",["string"]],["data.deviceModelName",["string"]],["data.deviceType",["string"]],["data.posDeviceInfo",["object"]],["data.posDeviceInfo.androidOsSdkLevel",["integer"]],["data.posDeviceInfo.androidOsVersion",["string"]],["data.posDeviceInfo.deviceId",["string"]],["data.posDeviceInfo.deviceName",["string"]],["data.posDeviceInfo.deviceUptimeMillis",["integer"]],["data.posDeviceInfo.firmwareVersion",["string"]],["data.posDeviceInfo.ipAddress",["string"]],["data.posDeviceInfo.ipType",["string"]],["data.posDeviceInfo.lastSyncedAt",["string"]],["data.posDeviceInfo.macAddress",["string"]],["data.posDeviceInfo.networkConnectionType",["string"]],["data.posDeviceInfo.networkName",["string"]],["data.posDeviceInfo.orderAutofireEnabled",["boolean"]],["data.posDeviceInfo.pciCompliant",["boolean"]],["data.posDeviceInfo.pciNonComplianceReason",["string"]],["data.posDeviceInfo.posAppVersion",["string"]],["data.posDeviceInfo.posType",["string"]],["data.posDeviceInfo.primaryMode",["string"]],["data.posDeviceInfo.securityPatchVersion",["string"]],["data.printerDeviceInfo",["object"]],["data.printerDeviceInfo.deviceName",["string"]],["data.printerDeviceInfo.firmwareVersion",["string"]],["data.printerDeviceInfo.gatewayAddress",["string"]],["data.printerDeviceInfo.ipAddress",["string"]],["data.printerDeviceInfo.ipType",["string"]],["data.printerDeviceInfo.lastSyncedAt",["string"]],["data.printerDeviceInfo.macAddress",["string"]],["data.printerDeviceInfo.netmaskAddress",["string"]],["data.printerDeviceInfo.printerPort",["string"]],["data.serialNumber",["string"]]]},"restaurants":{"version":"1.0.0","sha256":"cc0e007deac01ad602abb030522a777580bfa350e3891cac5fc452bb3e599d05","fields":[["data.delivery",["object"]],["data.delivery.area",["string"]],["data.delivery.enabled",["boolean"]],["data.delivery.minimum",["number"]],["data.general",["object"]],["data.general.archived",["boolean"]],["data.general.closeoutHour",["integer"]],["data.general.currencyCode",["string"]],["data.general.description",["string"]],["data.general.firstBusinessDate",["integer"]],["data.general.locationCode",["string"]],["data.general.locationName",["string"]],["data.general.managementGroupGuid",["string"]],["data.general.name",["string"]],["data.general.timeZone",["string"]],["data.guid",["string"]],["data.location",["object"]],["data.location.address1",["string"]],["data.location.address2",["string"]],["data.location.administrativeArea",["string"]],["data.location.city",["string"]],["data.location.country",["string"]],["data.location.latitude",["number"]],["data.location.longitude",["number"]],["data.location.phone",["string"]],["data.location.phoneCountryCode",["string"]],["data.location.stateCode",["string"]],["data.location.zipCode",["string"]],["data.onlineOrdering",["object"]],["data.onlineOrdering.enabled",["boolean"]],["data.onlineOrdering.paymentOptions",["object"]],["data.onlineOrdering.paymentOptions.ccTip",["boolean"]],["data.onlineOrdering.paymentOptions.delivery",["object"]],["data.onlineOrdering.paymentOptions.delivery.cash",["boolean"]],["data.onlineOrdering.paymentOptions.delivery.ccFuture",["boolean"]],["data.onlineOrdering.paymentOptions.delivery.ccSameDay",["boolean"]],["data.onlineOrdering.paymentOptions.takeout",["object"]],["data.onlineOrdering.paymentOptions.takeout.cash",["boolean"]],["data.onlineOrdering.paymentOptions.takeout.ccFuture",["boolean"]],["data.onlineOrdering.paymentOptions.takeout.ccInStore",["boolean"]],["data.onlineOrdering.paymentOptions.takeout.ccSameDay",["boolean"]],["data.onlineOrdering.scheduling",["boolean"]],["data.onlineOrdering.specialRequests",["boolean"]],["data.onlineOrdering.specialRequestsMessage",["string"]],["data.prepTimes",["object"]],["data.prepTimes.deliveryPrepTime",["integer"]],["data.prepTimes.deliveryThrottlingTime",["integer"]],["data.prepTimes.deliveryTimeAfterOpen",["integer"]],["data.prepTimes.deliveryTimeBeforeClose",["integer"]],["data.prepTimes.takeoutPrepTime",["integer"]],["data.prepTimes.takeoutThrottlingTime",["integer"]],["data.prepTimes.takeoutTimeAfterOpen",["integer"]],["data.prepTimes.takeoutTimeBeforeClose",["integer"]],["data.schedules",["object"]],["data.schedules.daySchedules",["object"]],["data.schedules.daySchedules.identifier",["string"]],["data.schedules.weekSchedule",["object"]],["data.schedules.weekSchedule.friday",["string"]],["data.schedules.weekSchedule.monday",["string"]],["data.schedules.weekSchedule.saturday",["string"]],["data.schedules.weekSchedule.sunday",["string"]],["data.schedules.weekSchedule.thursday",["string"]],["data.schedules.weekSchedule.tuesday",["string"]],["data.schedules.weekSchedule.wednesday",["string"]],["data.urls",["object"]],["data.urls.checkGiftCard",["string"]],["data.urls.facebook",["string"]],["data.urls.orderOnline",["string"]],["data.urls.purchaseGiftCard",["string"]],["data.urls.twitter",["string"]],["data.urls.website",["string"]]]}};
