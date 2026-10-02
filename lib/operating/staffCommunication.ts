import type { OperatingTask } from "./tasks";

export type StaffDeliveryResult = { delivered: true; providerMessageId: string } | { delivered: false; reason: "provider_unavailable" | "invalid_task" | "delivery_failed" };
export interface StaffCommunicationProvider {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  deliverCoverageRequest(task: OperatingTask, recipient: { employeeId: string; destination: string }): Promise<StaffDeliveryResult>;
}

/** Safe default: a missing SMS/WhatsApp provider is explicit and never looks like delivery. */
export class UnavailableStaffCommunicationProvider implements StaffCommunicationProvider {
  readonly name = "unavailable";
  async isAvailable() { return false; }
  async deliverCoverageRequest(task: OperatingTask, recipient: { employeeId: string; destination: string }) { void task; void recipient; return { delivered: false, reason: "provider_unavailable" } as const; }
}
