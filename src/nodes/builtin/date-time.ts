import { DateTime } from "luxon";
import { resolveParameterValue } from "../../expression/evaluator.ts";
import type { Item } from "../../schema/item.ts";
import type { NodeExecutor } from "../types.ts";

function toDateTime(value: unknown): DateTime {
  if (value instanceof DateTime) return value;
  if (value instanceof Date) return DateTime.fromJSDate(value);
  if (typeof value === "number") return DateTime.fromMillis(value);
  const str = String(value ?? "");
  if (/^-?\d+$/.test(str)) return DateTime.fromMillis(Number(str));
  const iso = DateTime.fromISO(str);
  return iso.isValid ? iso : DateTime.fromJSDate(new Date(str));
}

/**
 * Date & Time (v2): manipulates date values via Luxon. Field names verified
 * against `packages/nodes-base/nodes/DateTime/V2/*Description.ts`:
 * `parameters.operation` selects one of formatDate/addToDate/subtractFromDate/
 * getCurrentDate/extractDate/roundDate/getTimeBetweenDates, each with its own
 * `date`/`magnitude`/`startDate`+`endDate` input field(s) and an
 * `outputFieldName` (top-level, not nested) for where the result is written.
 * `type: "code"`-style custom logic isn't part of this node (unlike Sort).
 * `getCurrentDate` reuses the shared `scope.$now` (itself derived from
 * `runtime.now`, the `--now` override, and `workflow.settings.timezone`)
 * rather than calling `DateTime.now()` directly, so `--now`-pinned runs stay
 * reproducible and workflow-timezone-aware for this operation too.
 */
export const dateTimeExecutor: NodeExecutor = {
  type: "n8n-nodes-base.dateTime",
  execute: ({ node, inputItems, buildScope }) => {
    const outputItems: Item[] = inputItems.map((item, index) => {
      const scope = buildScope(item, index, inputItems);
      const p = resolveParameterValue(node.parameters, scope) as Record<
        string,
        unknown
      >;
      const operation = String(p.operation ?? "getCurrentDate");
      let outputFieldName = String(p.outputFieldName ?? "");
      let value: unknown;

      switch (operation) {
        case "formatDate": {
          outputFieldName ||= "formattedDate";
          const dt = toDateTime(p.date);
          const format = String(p.format ?? "MM/dd/yyyy");
          if (format === "custom")
            value = dt.toFormat(String(p.customFormat ?? ""));
          else if (format === "X") value = Math.floor(dt.toSeconds());
          else if (format === "x") value = dt.toMillis();
          else value = dt.toFormat(format);
          break;
        }
        case "addToDate":
        case "subtractFromDate": {
          outputFieldName ||= "newDate";
          const dt = toDateTime(p.magnitude);
          const unit = String(p.timeUnit ?? "days");
          const duration = Number(p.duration ?? 0);
          const delta = {
            [unit]: operation === "addToDate" ? duration : -duration,
          };
          value = dt.plus(delta).toISO();
          break;
        }
        case "getCurrentDate": {
          outputFieldName ||= "currentDate";
          const options = p.options as Record<string, unknown> | undefined;
          // `scope.$now` is already zoned to `workflow.settings.timezone`
          // (see expression/context.ts) - reuse it instead of rebuilding
          // from `runtime.now` directly, so this operation's default zone
          // matches real n8n's `DateTime.now()` under its workflow-scoped
          // `Settings.defaultZone` rather than always falling back to the
          // local system zone.
          let dt: DateTime = scope.$now;
          if (options?.timezone) dt = dt.setZone(String(options.timezone));
          if (p.includeTime === false)
            dt = dt.set({ hour: 0, minute: 0, second: 0, millisecond: 0 });
          value = dt.toISO();
          break;
        }
        case "extractDate": {
          outputFieldName ||= "datePart";
          const dt = toDateTime(p.date);
          const part = String(p.part ?? "day");
          value =
            (dt as unknown as Record<string, unknown>)[part] ??
            dt.get(part as "day");
          break;
        }
        case "roundDate": {
          outputFieldName ||= "roundedDate";
          const dt = toDateTime(p.date);
          const toNearest = String(p.toNearest ?? "month") as
            | "year"
            | "month"
            | "day"
            | "hour"
            | "minute"
            | "second";
          const mode = String(p.mode ?? "roundDown");
          const rounded =
            mode === "roundUp"
              ? dt.plus({ [toNearest]: 1 }).startOf(toNearest)
              : dt.startOf(toNearest);
          value = rounded.toISO();
          break;
        }
        case "getTimeBetweenDates": {
          outputFieldName ||= "timeDifference";
          const start = toDateTime(p.startDate);
          const end = toDateTime(p.endDate);
          const units = Array.isArray(p.units)
            ? (p.units as string[])
            : [String(p.units ?? "day")];
          const primaryUnit = ((units[0] ?? "day") +
            (units[0]?.endsWith("s") ? "" : "s")) as "days";
          value = end.diff(start, primaryUnit).as(primaryUnit);
          break;
        }
        default:
          value = null;
      }

      return {
        json: { ...item.json, [outputFieldName]: value },
        pairedItem: { item: index },
      };
    });

    return { status: "success", output: [outputItems] };
  },
};
