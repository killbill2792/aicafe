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
  "cv_dining_options"
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
    "meaning": "Recorded order discounts",
    "columns": {
      "check_discounts": {
        "meaning": "Named check-level discounts for this order.",
        "unit": "JSON cents",
        "source": "toast",
        "example": "Which discount names were used?"
      },
      "item_discounts": {
        "meaning": "Named item-level discounts for this order.",
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
    "meaning": "App pantry counts and Toast at-risk menu item stock captured snapshots",
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
        "meaning": "Toast menu-item reference for at-risk stock snapshots; absent items are not zero.",
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
        "meaning": "Café local business date associated with the record or sample.",
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
    "meaning": "Cash movements and deposits from redacted Toast diagnostics, not continuous cash sync.",
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
        "meaning": "Café local business date associated with the record or sample.",
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
    "meaning": "Toast kitchen fulfillment and prep station diagnostic snapshots; optional KDS/Pro access.",
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
        "meaning": "Café local business date associated with the record or sample.",
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
    "meaning": "Toast dining-option name configuration from optional redacted captures.",
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
        "meaning": "Café local business date associated with the record or sample.",
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
  }
} as const;
export function isCanonicalView(name:string):name is CanonicalView {
 return (canonicalViewNames as readonly string[]).includes(name);
}
export function isCanonicalColumn(view:CanonicalView,column:string):boolean {
 return Object.prototype.hasOwnProperty.call(canonicalDictionary[view].columns,column);
}
