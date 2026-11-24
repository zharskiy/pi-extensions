---
name: pinata-code-style
description: Use when writing or editing code in any programming language — enforces formatting rules (no for-loops, blank-line spacing around if-blocks and function calls, scoped just-in-time variable declarations, concise self-descriptive naming, no comments, validate external packages before adding them).
---

# Code Style

## Overview

Fixed formatting rules for all code, in every language. These are not suggestions — apply them by default, without being asked, every time code is written or edited.

## Rules

**No `for` loops.** Use list/iterator methods instead (`map`, `filter`, `reduce`, `forEach`, comprehensions, streams — whatever the language's idiomatic equivalent is).

**Blank line around `if` blocks.** One blank line before and one after an `if` block, *unless* that would put a blank line right at the start or end of the enclosing function/block (i.e. don't add a blank line immediately after `{` or immediately before the final `}`).

**Blank line around function-call statements.** Same rule as `if` blocks: a statement that is (or centers on) a function call gets a blank line before and after it, unless that edge is the start/end of the enclosing block.

**Variables declared just before use, scoped to where they're used — never hoisted to one block at the top of the function.**
- A variable used only inside a branch (an `if`, after an early return, etc.) is declared inside that branch, not above it.
- A variable is declared immediately before the code that consumes it.
- When several variables are needed together for the next step, declare that group together, then one blank line, then the code using them.
- Ordering follows dependencies: if a later variable's computation needs an earlier one, the earlier one is declared first — "just before use" yields to "before its consumer."

**Concise, self-descriptive names.** A reader should know what a variable or function holds/does from its name alone, without reading the implementation.

**No comments**, unless the user explicitly asks for one in that instance. Prefer clear code and naming over explanation.

**Validate external packages before use.** Before adding a new dependency (not already in the project), check it's maintained, reasonably scoped, and actually needed — don't `import`/`require` something new without that check.

Overall: optimize for a human reading the code once and understanding it immediately.

## Example

```typescript
function computeDiscount(order: Order, coupon: Coupon | null): number {
  if (coupon === null) {
    return 0;
  }

  const isExpired = coupon.expiresAt < Date.now();

  if (isExpired) {
    return 0;
  }

  const eligibleAmount = order.amount - order.shippingFee;
  const discountRate = coupon.rate;

  const discount = eligibleAmount * discountRate;

  return Math.min(discount, order.amount);
}

function summarizeOrders(orders: Order[], threshold: number): Summary {
  if (orders.length === 0) {
    return { count: 0, total: 0 };
  }

  const qualifying = orders
    .filter(order => order.status === 'paid')
    .filter(order => order.amount >= threshold);

  const total = qualifying.reduce((sum, order) => sum + order.amount, 0);

  return { count: qualifying.length, total };
}
```

Note how `isExpired` only exists inside the branch that needs it, `eligibleAmount`/`discountRate` are declared together right before the line that uses both, and every `if`/call-centered statement is padded with a blank line except where it touches the function's opening or closing brace.

## Common Rationalizations

| Excuse | Reality |
|---|---|
| "A `for` loop is clearer here" | Still not allowed — reach for the iterator method that matches the shape of the transform (`map`/`filter`/`reduce`/`find`/`some`). |
| "It's just one small helper, formatting doesn't matter" | The rules apply to every function, including small ones — no size exemption. |
| "I'll add a comment so future readers understand" | Rename instead. If the name doesn't say it, the comment is a patch for a bad name. |
| "Declaring it all at the top is more readable" | Not per these rules — declare at point of use, scoped to the branch that needs it. |
| "This package is tiny, no need to check it" | Validate every new dependency before importing it, regardless of size. |

## Red Flags — check before finishing any code you write

- A `for` loop, or a `while (...i++)` loop standing in for one
- Variables declared at the top of a function that are only used partway through or only in one branch
- An `if` block glued directly to the line above/below it with no blank line (and it isn't at the function's start/end)
- A comment added without being asked
- A new `import`/`require` for a package not already used in the project, added without checking it first
