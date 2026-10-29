import "../index.css";

import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

import { RateTab } from "./RateTab";
import { ResultsTab } from "./ResultsTab";
import { RunTab } from "./RunTab";

type Tab = "run" | "rate" | "results";

function BenchApp() {
  const params = new URLSearchParams(location.search);
  const [tab, setTab] = useState<Tab>((params.get("tab") as Tab) ?? "rate");
  const [run, setRun] = useState(params.get("run") ?? "r1");
  const [rater, setRater] = useState(() => {
    try {
      return localStorage.getItem("yay-bench-rater") ?? "";
    } catch {
      return "";
    }
  });

  const tabs: [Tab, string][] = [
    ["run", "Прогон"],
    ["rate", "Слепая оценка"],
    ["results", "Итоги"],
  ];
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <header className="flex flex-wrap items-center gap-4">
        <h1 className="text-lg font-semibold">Бенчмарк примерки</h1>
        <nav className="flex gap-1">
          {tabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`rounded-md px-3 py-1 text-sm ${tab === id ? "bg-neutral-900 text-white" : "hover:bg-neutral-100"}`}
            >
              {label}
            </button>
          ))}
        </nav>
        <label className="text-sm">
          Прогон{" "}
          <input value={run} onChange={(e) => setRun(e.target.value)} className="w-20 rounded border px-1" />
        </label>
        <label className="text-sm">
          Оценщик{" "}
          <input
            value={rater}
            onChange={(e) => {
              setRater(e.target.value);
              try {
                localStorage.setItem("yay-bench-rater", e.target.value);
              } catch {
                /* ignore */
              }
            }}
            placeholder="имя"
            className="w-28 rounded border px-1"
          />
        </label>
      </header>
      {tab === "run" && <RunTab run={run} />}
      {tab === "rate" && (rater ? <RateTab run={run} rater={rater} /> : <p className="text-sm">Введите имя оценщика.</p>)}
      {tab === "results" && <ResultsTab run={run} />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BenchApp />
  </StrictMode>,
);
