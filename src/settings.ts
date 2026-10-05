import { SettingKind, type TypedValue } from './generated/primandproper/platform/settings/v1/settings';

/**
 * SettingValueRefusal is why text cannot be written as a setting's value:
 *
 * - `not-of-kind`: the text is not a value of the setting's kind, as the server reads one.
 * - `unknown-kind`: the kind has no value case to write. Unspecified, which the server refuses to define a setting as,
 *   or one newer than this client. A form showing this has a bug, not a bad answer.
 * - `unsafe-integer`: an integer the server would accept, but beyond `Number.MAX_SAFE_INTEGER`, which is as far as the
 *   generated `TypedValue.intValue` (a `number`) holds one exactly.
 */
export type SettingValueRefusal = 'not-of-kind' | 'unknown-kind' | 'unsafe-integer';

/** SettingValueError is text a form holds that cannot be written as a setting's value. */
export class SettingValueError extends Error {
  readonly reason: SettingValueRefusal;
  readonly text: string;
  readonly kind: SettingKind;

  constructor(reason: SettingValueRefusal, text: string, kind: SettingKind) {
    super(describe(reason, text, kind));
    this.name = 'SettingValueError';
    this.reason = reason;
    this.text = text;
    this.kind = kind;
  }
}

/**
 * typedValueFromText is the value a write carries for `text`, a form's answer to a setting of `kind`. The case follows
 * `kind` and never `text`, because the server refuses a case that is not the setting's kind (settings.ErrKindMismatch):
 * a string setting is written as text even when its answer looks like a number.
 *
 * Text is a value of a kind when Go's strconv reads it as one, which is how the server checks a definition's default
 * and enumeration: "true", "True", "t" and "1" are all booleans, "+5" is an integer, and "NaN", "-Inf" and "1_000" are
 * floats. An integer or a float out of range is not. Anything that is not throws `SettingValueError`.
 */
export function typedValueFromText(text: string, kind: SettingKind): TypedValue {
  switch (kind) {
    case SettingKind.SETTING_KIND_STRING:
      return { stringValue: text };
    case SettingKind.SETTING_KIND_BOOLEAN: {
      const flag = goBool(text);
      if (flag === undefined) {
        throw new SettingValueError('not-of-kind', text, kind);
      }
      return { boolValue: flag };
    }
    case SettingKind.SETTING_KIND_INTEGER:
      return { intValue: goInt(text, kind) };
    case SettingKind.SETTING_KIND_FLOAT: {
      const number = goFloat(text);
      if (number === undefined) {
        throw new SettingValueError('not-of-kind', text, kind);
      }
      return { floatValue: number };
    }
    default:
      throw new SettingValueError('unknown-kind', text, kind);
  }
}

/**
 * textFromTypedValue is the value as the server stores it, which is the form a definition's enumeration is compared in:
 * "true" or "false", base ten, and a float as Go's `strconv.FormatFloat(f, 'g', -1, 64)` writes it ("1", "1e+06",
 * "NaN").
 *
 * It is undefined when no case is set, which is how a resolution whose source is `VALUE_SOURCE_UNSET` reads, and
 * undefined is not "": a string setting answered with nothing is "".
 */
export function textFromTypedValue(value: TypedValue | undefined): string | undefined {
  if (value?.stringValue !== undefined) {
    return value.stringValue;
  }
  if (value?.boolValue !== undefined) {
    return String(value.boolValue);
  }
  if (value?.intValue !== undefined) {
    return String(value.intValue);
  }
  if (value?.floatValue !== undefined) {
    return goFormat(value.floatValue);
  }
  return undefined;
}

function describe(reason: SettingValueRefusal, text: string, kind: SettingKind): string {
  const quoted = JSON.stringify(text);
  switch (reason) {
    case 'not-of-kind':
      return kind === SettingKind.SETTING_KIND_INTEGER
        ? `${quoted} is not an integer`
        : `${quoted} is not a ${kindName(kind)}`;
    case 'unknown-kind':
      return `a setting of ${kindName(kind)} kind has no value this client can write`;
    case 'unsafe-integer':
      return `${quoted} is an integer beyond what this client holds exactly`;
  }
}

function kindName(kind: SettingKind): string {
  switch (kind) {
    case SettingKind.SETTING_KIND_STRING:
      return 'string';
    case SettingKind.SETTING_KIND_BOOLEAN:
      return 'boolean';
    case SettingKind.SETTING_KIND_INTEGER:
      return 'integer';
    case SettingKind.SETTING_KIND_FLOAT:
      return 'float';
    case SettingKind.SETTING_KIND_UNSPECIFIED:
      return 'unspecified';
    default:
      return `unrecognized (${String(kind)})`;
  }
}

/** goBool reads `text` as Go's strconv.ParseBool does, or is undefined where it refuses it. */
function goBool(text: string): boolean | undefined {
  switch (text) {
    case '1':
    case 't':
    case 'T':
    case 'TRUE':
    case 'true':
    case 'True':
      return true;
    case '0':
    case 'f':
    case 'F':
    case 'FALSE':
    case 'false':
    case 'False':
      return false;
    default:
      return undefined;
  }
}

const int64Min = -(2n ** 63n);
const int64Max = 2n ** 63n - 1n;

/**
 * goInt reads `text` as Go's strconv.ParseInt(text, 10, 64) does, throwing where it refuses it, and throwing as well for
 * an int64 a `number` cannot hold exactly. That one is refused rather than rounded, because a rounded integer is a
 * different value written without anyone choosing it; the generated decoder refuses the same range on the way in.
 */
function goInt(text: string, kind: SettingKind): number {
  if (!/^[+-]?[0-9]+$/.test(text)) {
    throw new SettingValueError('not-of-kind', text, kind);
  }
  const number = BigInt(text);
  if (number < int64Min || number > int64Max) {
    throw new SettingValueError('not-of-kind', text, kind);
  }
  if (number < BigInt(Number.MIN_SAFE_INTEGER) || number > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SettingValueError('unsafe-integer', text, kind);
  }
  return Number(number);
}

const decimalFloat = /^([0-9_]*)(?:\.([0-9_]*))?(?:[eE][+-]?[0-9][0-9_]*)?$/;
const hexFloat = /^0[xX]([0-9a-fA-F_]*)(?:\.([0-9a-fA-F_]*))?[pP]([+-]?[0-9][0-9_]*)$/;

/**
 * goFloat reads `text` as Go's strconv.ParseFloat(text, 64) does, or is undefined where it refuses it, out of range
 * included. JavaScript's Number(text) admits a different syntax (no underscores, no hexadecimal fractions, "Infinity"
 * but not "inf"), so the syntax is checked here, and Number only converts decimal text.
 */
function goFloat(text: string): number | undefined {
  let body = text;
  let negative = false;
  if (body.startsWith('+') || body.startsWith('-')) {
    negative = body.startsWith('-');
    body = body.slice(1);
  }
  switch (body.toLowerCase()) {
    case 'inf':
    case 'infinity':
      return negative ? -Infinity : Infinity;
    case 'nan':
      // Go reads "nan" in any case, and never with a sign.
      return body.length === text.length ? NaN : undefined;
  }
  if (body.includes('_') && !underscoresSeparateDigits(body)) {
    return undefined;
  }

  let magnitude: number;
  const hex = hexFloat.exec(body);
  const decimal = hex ? null : decimalFloat.exec(body);
  if (hex) {
    const digits = stripUnderscores(`${hex[1] ?? ''}${hex[2] ?? ''}`);
    if (digits === '') {
      return undefined;
    }
    const exponent = Number(stripUnderscores(hex[3] ?? '')) - 4 * stripUnderscores(hex[2] ?? '').length;
    magnitude = scaleByPowerOfTwo(BigInt(`0x${digits}`), exponent);
  } else if (decimal && /[0-9]/.test(`${decimal[1] ?? ''}${decimal[2] ?? ''}`)) {
    magnitude = Number(stripUnderscores(body));
  } else {
    return undefined;
  }
  if (!Number.isFinite(magnitude)) {
    return undefined;
  }
  return negative ? -magnitude : magnitude;
}

function stripUnderscores(text: string): string {
  return text.replaceAll('_', '');
}

/**
 * underscoresSeparateDigits is Go's underscoreOK, for an unsigned number: each underscore sits between two digits, or
 * between the base prefix and a digit.
 */
function underscoresSeparateDigits(body: string): boolean {
  const hex = /^0[xX]/.test(body);
  const digit = hex ? /[0-9a-fA-F]/ : /[0-9]/;
  let last: 'start' | 'digit' | 'underscore' | 'other' = hex ? 'digit' : 'start';
  for (const c of hex ? body.slice(2) : body) {
    if (digit.test(c)) {
      last = 'digit';
    } else if (c === '_') {
      if (last !== 'digit') {
        return false;
      }
      last = 'underscore';
    } else if (last === 'underscore') {
      return false;
    } else {
      last = 'other';
    }
  }
  return last !== 'underscore';
}

/**
 * scaleByPowerOfTwo is `mantissa` × 2^`exponent` rounded to the nearest double, ties to even, as Go rounds a
 * hexadecimal float. It rounds the mantissa to the bits the result has room for (fewer than 53 when it is subnormal)
 * first, so the scaling after is exact and nothing is rounded twice.
 */
function scaleByPowerOfTwo(mantissa: bigint, exponent: number): number {
  if (mantissa === 0n) {
    return 0;
  }
  const bits = mantissa.toString(2).length;
  const top = bits - 1 + exponent;
  if (top > 1023) {
    return Infinity;
  }
  if (top < -1076) {
    return 0;
  }
  const precision = Math.min(53, top + 1075);
  const shift = bits - precision;
  if (shift > 0) {
    const s = BigInt(shift);
    const rest = mantissa & ((1n << s) - 1n);
    const half = 1n << (s - 1n);
    mantissa >>= s;
    if (rest > half || (rest === half && (mantissa & 1n) === 1n)) {
      mantissa += 1n;
    }
    exponent += shift;
  }
  // In two steps, because 2^exponent alone can underflow to zero where the product does not.
  const first = Math.trunc(exponent / 2);
  return Number(mantissa) * 2 ** first * 2 ** (exponent - first);
}

/**
 * goFormat writes `number` as Go's strconv.FormatFloat(number, 'g', -1, 64) does. toExponential() with no argument
 * gives the same shortest digits that read back as `number`, so this lays those digits out as Go does: an exponent
 * below -4 or from 6 up is written as one, with at least two digits, and anything else is written out in full.
 */
function goFormat(number: number): string {
  if (Number.isNaN(number)) {
    return 'NaN';
  }
  if (!Number.isFinite(number)) {
    return number < 0 ? '-Inf' : '+Inf';
  }
  const sign = number < 0 || Object.is(number, -0) ? '-' : '';
  if (number === 0) {
    return `${sign}0`;
  }

  const [mantissa = '', power = ''] = Math.abs(number).toExponential().split('e');
  const digits = mantissa.replace('.', '');
  const exponent = Number(power);
  if (exponent < -4 || exponent >= 6) {
    const fraction = digits.length > 1 ? `.${digits.slice(1)}` : '';
    const magnitude = String(Math.abs(exponent)).padStart(2, '0');
    return `${sign}${digits.slice(0, 1)}${fraction}e${exponent < 0 ? '-' : '+'}${magnitude}`;
  }

  const point = exponent + 1;
  if (point <= 0) {
    return `${sign}0.${'0'.repeat(-point)}${digits}`;
  }
  if (point >= digits.length) {
    return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  }
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}
