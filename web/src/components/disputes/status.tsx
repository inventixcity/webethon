import { CircleCheck, CircleDashed, CircleX } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { DisputeStatus } from "@/lib/exam/types";
import { STATUS_LABEL } from "./format";

/** Status is carried by its word and an icon, never by colour alone. */
export function DisputeStatusBadge({ status }: { status: DisputeStatus }) {
  if (status === "accepted") {
    return (
      <Badge tone="outline">
        <CircleCheck aria-hidden="true" className="size-3.5 shrink-0" />
        {STATUS_LABEL.accepted}
      </Badge>
    );
  }
  if (status === "rejected") {
    return (
      <Badge tone="muted">
        <CircleX aria-hidden="true" className="size-3.5 shrink-0" />
        {STATUS_LABEL.rejected}
      </Badge>
    );
  }
  return (
    <Badge tone="info">
      <CircleDashed aria-hidden="true" className="size-3.5 shrink-0" />
      {STATUS_LABEL.open}
    </Badge>
  );
}
