# duration

Parse human-friendly durations.

## Installation

Copy `src/duration.mjs` into your project.

## Usage

```js
import { parseDuration } from "./src/duration.mjs";

parseDuration("1h30m"); // => 5400
parseDuration("45s"); // => 45
```

Supported units: `h` (hours), `m` (minutes), `s` (seconds). Units can be combined.

## Errors

Invalid input such as `"5x"` throws an `Error` with the message `invalid duration: 5x`.
