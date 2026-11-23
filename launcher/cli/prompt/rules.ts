import type { Choice, NumberSpec } from "./types.ts";

export const DIGITS = /^[0-9]+$/;

export const numberProblem = (
  spec: Pick<NumberSpec, "initial" | "min" | "max" | "tooLow" | "tooHigh">,
  text: string,
) => {
  if (text === "") {
    return "Type a number.";
  }

  if (!DIGITS.test(text)) {
    return `Type a whole number, like ${spec.initial}.`;
  }

  const value = Number(text);

  if (value < spec.min) {
    return spec.tooLow;
  }

  return value > spec.max ? (spec.tooHigh ?? spec.tooLow) : undefined;
};

export const warningFor = (spec: Pick<NumberSpec, "warn">, value: number, warned: number | undefined) =>
  warned === value ? undefined : spec.warn?.(value);

export const initialIndex = <T>(choices: Choice<T>[], initial: T | undefined) =>
  Math.max(
    0,
    choices.findIndex((choice) => choice.value === initial),
  );
