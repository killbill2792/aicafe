import {financialSettlementInputSchema,financialBillInputSchema} from "@/lib/ai/supervisor/loop/supplierReceiving.server";
import type {AgentToolContext,AgentToolResult} from "./index";
export const moneyTools={
  propose_financial_settlement:{
    agentId:"leo",schema:financialSettlementInputSchema,
    description:"Draft documentary debit allocation or credit reversal for exact invoice revision and statement row; owner confirms. No money movement or unverified paid claim.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const input=financialSettlementInputSchema.parse(raw);
      if(!ctx.financialSettlementPropose)return {source:"supplier_purchase_proposal",period:null,agentId:"leo",missing:["financialSettlementUnavailable"],draft:false,paymentMade:false};
      return {source:"supplier_purchase_proposal",proposalKind:"financial_settlement",period:null,agentId:"leo",
        missing:[],draft:true,saved:false,approvalRequired:true,paymentMade:false,...await ctx.financialSettlementPropose(input)};
    },
  },
  propose_financial_bill:{
    agentId:"leo",schema:financialBillInputSchema,
    description:"Draft an owner-confirmed dated non-supplier bill claim, not configured recurring rent, expense or payment. Exact payee, document reference, date, currency and amount required.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const input=financialBillInputSchema.parse(raw);
      if(!ctx.financialBillPropose)return {source:"supplier_purchase_proposal",period:null,agentId:"leo",missing:["financialBillUnavailable"],draft:false,paymentMade:false};
      return {source:"supplier_purchase_proposal",proposalKind:"financial_bill",period:null,agentId:"leo",
       missing:[],draft:true,saved:false,approvalRequired:true,paymentMade:false,...await ctx.financialBillPropose(input)};
    }
  },
} as const;
