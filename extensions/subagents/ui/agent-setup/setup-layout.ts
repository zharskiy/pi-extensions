export const INFO_ROWS = 3;

export const GAP_ROWS = 1;

export const DETAIL_LINES = 2;

const PICKER_CHROME_ROWS = 3;

export const blockRows = (fieldRows: number, presetRows: number) =>
  fieldRows + GAP_ROWS + presetRows + GAP_ROWS + INFO_ROWS;

export const listHeight = (block: number, field: string) =>
  block - PICKER_CHROME_ROWS - (field === "skills" ? DETAIL_LINES : 0);
