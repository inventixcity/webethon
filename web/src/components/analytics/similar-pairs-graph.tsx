"use client";

import { useMemo } from "react";
import { ForceGraph } from "@/components/effects/force-graph";
import type { ExamAnalytics } from "@/lib/exam/types";

type Pair = ExamAnalytics["similarPairs"][number];

/**
 * Candidates as nodes and similar-answer pairs as links. The graph is an indicator for review only, and the caller
 * always shows the disclaimer beside it. Edge weight (identical wrong answers) is listed in the table next to it.
 */
export function SimilarPairsGraph({ pairs }: { pairs: readonly Pair[] }) {
  const nodes = useMemo(() => {
    const names = new Set<string>();
    for (const pair of pairs) {
      names.add(pair.a);
      names.add(pair.b);
    }
    return [...names].map((name) => ({ id: name, label: name }));
  }, [pairs]);

  const links = useMemo(() => pairs.map((pair) => [pair.a, pair.b] as const), [pairs]);

  return (
    <ForceGraph
      nodes={nodes}
      links={links}
      label={`Network of ${nodes.length} candidates linked by ${pairs.length} similar-answer ${pairs.length === 1 ? "pair" : "pairs"}. Indicator only.`}
    />
  );
}
