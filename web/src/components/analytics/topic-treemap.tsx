"use client";

import { motion, useReducedMotion } from "motion/react";
import { useMemo } from "react";
import { squarify } from "@/components/effects/treemap-shift/squarify";
import type { ExamAnalytics } from "@/lib/exam/types";
import { cn } from "@/lib/utils";
import { formatPercent } from "./format";

type Topic = ExamAnalytics["topics"][number];

// The layout is computed in a fixed reference box and placed in percentages, so the map scales with its column.
const W = 1000;
const H = 560;
const GAP = 3;

/** Tone by mean percent: strong topics are ink, middling ones sand, and weak ones amber because they need a look. */
export function topicTone(meanPercent: number): string {
  if (meanPercent >= 70) return "bg-cobalt text-paper";
  if (meanPercent >= 50) return "bg-paper-sunk text-ink";
  return "bg-amber text-ink";
}

/**
 * Topic performance as a treemap. Each tile's area is the number of items on the topic, and its tone shows the mean
 * percent. The layout is the squarify pass from the treemap effect. Each tile is a list item with its numbers in the
 * DOM, so the figures read out in full.
 */
export function TopicTreemap({ topics }: { topics: Topic[] }) {
  const reduced = useReducedMotion() ?? false;
  const boxes = useMemo(
    () => squarify(topics.map((topic) => Math.max(1, topic.items)), { x: 0, y: 0, width: W, height: H }),
    [topics],
  );

  return (
    <figure className="grid gap-4">
      <ul aria-label="Topic performance tiles" className="relative w-full overflow-hidden border border-ink" style={{ aspectRatio: `${W} / ${H}` }}>
        {topics.map((topic, index) => {
          const box = boxes[index];
          if (!box) return null;
          const small = box.width < 170 || box.height < 110;
          return (
            <motion.li
              key={topic.topic}
              initial={reduced ? false : { opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.3, delay: reduced ? 0 : index * 0.04, ease: [0.22, 1, 0.36, 1] }}
              title={`${topic.topic}: ${formatPercent(topic.meanPercent, 1)} mean across ${topic.items} items`}
              className={cn(
                "absolute grid content-between overflow-hidden p-3 transition-colors duration-(--duration-base) hover:brightness-110",
                topicTone(topic.meanPercent),
              )}
              style={{
                left: `${(box.x / W) * 100}%`,
                top: `${(box.y / H) * 100}%`,
                width: `calc(${(box.width / W) * 100}% - ${GAP}px)`,
                height: `calc(${(box.height / H) * 100}% - ${GAP}px)`,
              }}
            >
              <span className={cn("min-w-0 truncate font-medium", small ? "text-sm" : "text-base")}>{topic.topic}</span>
              <span className="grid gap-1">
                <span className={cn("leading-none font-medium tracking-[-0.03em] tabular-nums", small ? "text-2xl" : "text-[clamp(1.75rem,3vw,2.75rem)]")}>
                  {formatPercent(topic.meanPercent, 0)}
                </span>
                <span className="font-mono text-[11px] tracking-[0.06em] uppercase opacity-80">
                  {topic.items} {topic.items === 1 ? "item" : "items"}
                </span>
              </span>
            </motion.li>
          );
        })}
      </ul>
      <figcaption className="flex flex-wrap gap-x-6 gap-y-2 font-mono text-[11px] tracking-[0.06em] text-ink-muted uppercase">
        <span className="inline-flex items-center gap-2">
          <span aria-hidden="true" className="size-2.5 bg-cobalt" />
          70% and above
        </span>
        <span className="inline-flex items-center gap-2">
          <span aria-hidden="true" className="size-2.5 bg-paper-sunk border border-ink" />
          50 to 70%
        </span>
        <span className="inline-flex items-center gap-2">
          <span aria-hidden="true" className="size-2.5 bg-amber" />
          Below 50%, worth a look
        </span>
        <span>Area = items per topic</span>
      </figcaption>
    </figure>
  );
}
