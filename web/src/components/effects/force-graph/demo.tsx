"use client";

import { DemoFrame } from "../demo-frame";
import { ForceGraph } from "./force-graph";

const NAMES = [
  "Accounts", "Sign-in", "Sessions", "Profiles", "Teams", "Roles", "Billing", "Plans", "Invoices", "Checkout",
  "Search", "Index", "Feed", "Comments", "Uploads", "Storage", "Email", "Alerts", "Analytics", "Events",
  "Exports", "AI assistant", "Prompts", "Embeddings",
];

const NODES = NAMES.map((label) => ({ id: label, label }));

const LINKS = [
  ["Accounts", "Sign-in"], ["Sign-in", "Sessions"], ["Accounts", "Profiles"], ["Accounts", "Teams"], ["Teams", "Roles"],
  ["Accounts", "Billing"], ["Billing", "Plans"], ["Billing", "Invoices"], ["Billing", "Checkout"], ["Invoices", "Email"],
  ["Search", "Index"], ["Search", "Feed"], ["Feed", "Comments"], ["Comments", "Alerts"], ["Comments", "Profiles"],
  ["Uploads", "Storage"], ["Uploads", "Index"], ["Uploads", "Comments"], ["Email", "Alerts"], ["Alerts", "Events"],
  ["Analytics", "Events"], ["Analytics", "Exports"], ["Exports", "Storage"], ["AI assistant", "Prompts"],
  ["AI assistant", "Embeddings"], ["AI assistant", "Search"], ["Embeddings", "Index"], ["AI assistant", "Analytics"],
  ["Sessions", "Events"], ["Roles", "Exports"], ["Checkout", "Events"],
] as const;

export default function Demo() {
  return (
    <DemoFrame index="Data" title="Force graph" note="Grab a node and pull. Hover one to trace its links, or use the chips below.">
      <ForceGraph nodes={NODES} links={LINKS} label="How the parts of a product connect" />
    </DemoFrame>
  );
}
