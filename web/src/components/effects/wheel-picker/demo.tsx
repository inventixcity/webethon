"use client";

import { useState } from "react";
import { DemoFrame } from "../demo-frame";
import { WheelPicker } from "./wheel-picker";

const HOURS = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, "0"));
const MINUTES = Array.from({ length: 12 }, (_, index) => String(index * 5).padStart(2, "0"));
const PERIODS = ["AM", "PM"];

export default function Demo() {
  const [hour, setHour] = useState("08");
  const [minute, setMinute] = useState("30");
  const [period, setPeriod] = useState("PM");

  return (
    <DemoFrame index="Controls" title="Wheel picker" note="A real 3D drum for times and dates. Flick it and it coasts, then clicks into a row.">
      <div className="grid justify-items-center gap-6">
        <div className="flex gap-2">
          <WheelPicker label="Hour" items={HOURS} value={hour} onChange={setHour} />
          <WheelPicker label="Minute" items={MINUTES} value={minute} onChange={setMinute} />
          <WheelPicker label="AM or PM" items={PERIODS} value={period} onChange={setPeriod} />
        </div>
        <p className="font-mono text-sm">
          Booked for {hour}:{minute} {period}
        </p>
      </div>
    </DemoFrame>
  );
}
