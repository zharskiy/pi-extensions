import type { ThemeLike } from "../../../platform/pi-adapter/index.ts";
import { DOT } from "../../../platform/shared/index.ts";

export type Segment = {
  text: string;
  drop: number;
  tight?: boolean;
  next?: Segment;
};

type Placed = { segment: Segment; width: number };

const GAP = 2;

const place = (theme: ThemeLike, segment: Segment): Placed => ({ segment, width: theme.width(segment.text) });

const sideWidth = (placed: Placed[], dotWidth: number) =>
  placed.reduce((sum, { segment, width }, index) => {
    if (index === 0) {
      return width;
    }

    return sum + width + (segment.tight ? 1 : dotWidth);
  }, 0);

const lowestDrop = (sides: Placed[][]) =>
  Math.min(...sides.flatMap((side) => side.map(({ segment }) => segment.drop)));

const applyDrop = (theme: ThemeLike, side: Placed[], level: number) =>
  side.flatMap((entry) => {
    if (entry.segment.drop !== level) {
      return [entry];
    }

    return entry.segment.next ? [place(theme, entry.segment.next)] : [];
  });

const joinSide = (theme: ThemeLike, placed: Placed[]) =>
  placed
    .map(({ segment }, index) => {
      if (index === 0) {
        return segment.text;
      }

      return `${segment.tight ? " " : theme.fg("dim", DOT)}${segment.text}`;
    })
    .join("");

const shrinkToFit = (
  theme: ThemeLike,
  sides: Placed[][],
  fits: (sides: Placed[][]) => boolean,
): Placed[][] => {
  const level = lowestDrop(sides);

  if (fits(sides) || level === Number.POSITIVE_INFINITY) {
    return sides;
  }

  return shrinkToFit(
    theme,
    sides.map((side) => applyDrop(theme, side, level)),
    fits,
  );
};

export const spread = (theme: ThemeLike, left: Segment[], right: Segment[], width: number) => {
  const dotWidth = theme.width(DOT);
  const fits = ([l, r]: Placed[][]) =>
    sideWidth(l, dotWidth) + (r.length > 0 ? GAP + sideWidth(r, dotWidth) : 0) <= width;
  const [fittedLeft, fittedRight] = shrinkToFit(
    theme,
    [left.map((segment) => place(theme, segment)), right.map((segment) => place(theme, segment))],
    fits,
  );

  if (!fits([fittedLeft, fittedRight])) {
    return theme.truncate(joinSide(theme, fittedLeft), width);
  }

  if (fittedRight.length === 0) {
    return joinSide(theme, fittedLeft);
  }

  const padding = width - sideWidth(fittedLeft, dotWidth) - sideWidth(fittedRight, dotWidth);

  return `${joinSide(theme, fittedLeft)}${" ".repeat(padding)}${joinSide(theme, fittedRight)}`;
};
