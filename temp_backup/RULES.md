# Project Rules & Best Practices

## 1. Environment: Cloudflare Workers
- **Runtime**: Cloudflare Workers (V8 based, NOT Node.js).
- **Constraints**:
  - Stateless execution (global variables do not persist between requests).
  - Strict CPU time limits (avoid heavy processing loops).
  - NO native Node.js modules (`fs`, `path`, `crypto` must use Web Standards).
- **Bindings**:
  - Database: `c.env.DB` (D1 SQLite).
  - Storage: `c.env.BUCKET` (R2).

## 2. Critical: BigInt & Type Safety
The project uses `BigInt` heavily for Telegram IDs. The following patterns are **MANDATORY**:

- **FORBIDDEN**: `Math.max()` or `Math.min()` with BigInts.
  - *Reason*: Throws `Cannot convert a BigInt value to a number`.
  - *Fix*: Use manual comparison: `if (curr > max) max = curr;`.
  
- **FORBIDDEN**: `BigInt(variable)` without null-check.
  - *Reason*: D1 returns `null` for empty queries. `BigInt(null)` throws TypeError.
  - *Fix*: ALWAYS use a helper or fallback: `BigInt(val ?? 0)`.

- **MANDATORY**: Global Polyfill for JSON.
  - Add `BigInt.prototype.toJSON = function() { return this.toString() }` at the entry point.

## 3. Telegram API (GramJS) Rules
- **Iterators**: ALWAYS use `client.iterMessages()`. DO NOT use `client.getMessages()` manually for pagination.
- **IDs**: Channel IDs and Message IDs passed to GramJS MUST be `BigInt`.
  - Example: `client.iterMessages(BigInt(channelId), { ... })`.
- **Filtering**:
  - When using `min_id` or `offset_id`, ensure they are **BigInts**.
  - `limit` must be a **Number**.

## 4. Database (Cloudflare D1)
- **Wait Handling**: D1 queries are async. Always `await` them.
- **Empty Results**: `SELECT MAX(...)` returns `{ lastId: null }` if table is empty. Handle this explicitly.
- **Upsert**: Use `INSERT OR REPLACE` or `ON CONFLICT` clauses to handle duplicate message IDs safely.

## 5. Refactoring Strategy
- **Don't Patch**: Do not apply "quick fixes" to individual lines if a systematic error exists.
- **Utility Functions**: If a type conversion is used more than twice, create a global utility function (e.g., `toBigInt()`) and refactor the code to use it.