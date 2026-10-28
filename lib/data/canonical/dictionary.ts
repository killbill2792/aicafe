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
  "cv_analytics"
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
      "payment_type": {"meaning":"Toast payment method (card/cash/gift), when supplied.","unit":"label","source":"toast","example":"How much was paid by card?"},
      "card_type": {"meaning":"Card network/type from Toast, when supplied.","unit":"label","source":"toast","example":"What was Visa volume?"},
      "card_entry_mode": {"meaning":"How the card was entered, from Toast.","unit":"label","source":"toast","example":"What were keyed-card fees?"},
      "original_processing_fee_cents": {"meaning":"Original Toast-reported fee, not an estimate.","unit":"cents","source":"toast","example":"What fee did Toast report?"},
      "processing_fee_cents": {"meaning":"Selected fee per payment, or null when unknown.","unit":"cents","source":"toast","example":"What were the processing fees?"},
      "fee_status": {"meaning":"Actual, estimated or missing fee provenance.","unit":"label","source":"toast","example":"Which fees are estimates?"},
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
      "regular_hours": {"meaning":"Regular hours exactly supplied by Toast; nullable.","unit":"hours","source":"toast","example":"What regular hours did Toast record?"},
      "overtime_hours": {"meaning":"Overtime hours exactly supplied by Toast; nullable.","unit":"hours","source":"toast","example":"What overtime did Toast record?"},
      "hourly_wage_cents": {"meaning":"Recorded hourly wage in integer cents; nullable when unknown.","unit":"cents/hour","source":"toast","example":"What wage did Toast supply?"},
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
    "meaning": "Recorded stock counts",
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
  }
} as const;
export function isCanonicalView(name:string):name is CanonicalView {
 return (canonicalViewNames as readonly string[]).includes(name);
}
export function isCanonicalColumn(view:CanonicalView,column:string):boolean {
 return Object.prototype.hasOwnProperty.call(canonicalDictionary[view].columns,column);
}
