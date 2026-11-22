"use client";

import { useEffect, useState } from "react";
import { apiRequest } from "@/lib/api-client";
import type { LocationNode } from "@/lib/partner-types";
import { buttonSecondary, inputClass, labelClass } from "../ui/primitives";

/**
 * Province → District → City/Area picker over GET /api/v1/locations (one level per request, so
 * it stays light on mobile data). The chosen (deepest) location's id goes into a hidden input
 * named `name`, so the surrounding form reads it with FormData like any other field.
 */
export function LocationPicker({
  name,
  label,
  current,
  required = false,
}: {
  name: string;
  label: string;
  current?: { id: string; name: string } | null;
  required?: boolean;
}) {
  const [changing, setChanging] = useState(!current);
  const [levels, setLevels] = useState<LocationNode[][]>([]);
  const [chosen, setChosen] = useState<LocationNode[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!changing || levels.length > 0) return;
    let cancelled = false;
    apiRequest<{ data: LocationNode[] }>("/locations")
      .then((body) => !cancelled && setLevels([body.data]))
      .catch(() => !cancelled && setError("Places could not be loaded. Try again."));
    return () => {
      cancelled = true;
    };
  }, [changing, levels.length]);

  async function choose(depth: number, id: string) {
    const node = levels[depth]?.find((n) => n.id === id);
    const path = [...chosen.slice(0, depth), ...(node ? [node] : [])];
    setChosen(path);
    setLevels((prev) => prev.slice(0, depth + 1));
    if (node?.hasChildren) {
      try {
        const body = await apiRequest<{ data: LocationNode[] }>(
          `/locations?parentId=${encodeURIComponent(node.id)}`,
        );
        setLevels((prev) => [...prev.slice(0, depth + 1), body.data]);
      } catch {
        setError("Places could not be loaded. Try again.");
      }
    }
  }

  const value = changing ? (chosen.at(-1)?.id ?? "") : (current?.id ?? "");
  return (
    <fieldset className="space-y-2">
      <legend className={labelClass}>{label}</legend>
      <input type="hidden" name={name} value={value} />
      {!changing && current ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="font-medium text-ink">{current.name}</span>
          <button type="button" className={buttonSecondary} onClick={() => setChanging(true)}>
            Change
          </button>
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-3">
          {levels.map((options, depth) => (
            <select
              key={depth}
              aria-label={`${label}: ${depth === 0 ? "region" : "area"} ${depth + 1}`}
              className={inputClass}
              value={chosen[depth]?.id ?? ""}
              required={required && depth === 0}
              onChange={(e) => void choose(depth, e.target.value)}
            >
              <option value="">{depth === 0 ? "Choose…" : "Any / choose…"}</option>
              {options.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.name}
                </option>
              ))}
            </select>
          ))}
        </div>
      )}
      {changing && chosen.length > 0 ? (
        <p className="text-xs text-slate-600" data-testid={`${name}-chosen`}>
          Chosen: {chosen.map((n) => n.name).join(" › ")}
        </p>
      ) : null}
      {error ? <p className="text-sm text-red-900">{error}</p> : null}
    </fieldset>
  );
}
