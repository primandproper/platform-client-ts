import { describe, expect, it } from 'vitest';

import {
  type ResolvedSetting,
  SettingKind,
  type TypedValue,
  ValueSource,
} from './generated/primandproper/platform/settings/v1/settings';
import { SettingValueError, textFromTypedValue, typedValueFromText } from './settings';

const { SETTING_KIND_STRING, SETTING_KIND_BOOLEAN, SETTING_KIND_INTEGER, SETTING_KIND_FLOAT } = SettingKind;

function refusal(text: string, kind: SettingKind): SettingValueError {
  try {
    typedValueFromText(text, kind);
  } catch (error) {
    if (error instanceof SettingValueError) {
      return error;
    }
    throw error;
  }
  throw new Error(`${JSON.stringify(text)} was accepted as kind ${String(kind)}`);
}

describe('typedValueFromText and textFromTypedValue', () => {
  it('round trips a value of each kind', () => {
    const cases: [string, SettingKind, TypedValue][] = [
      ['metric', SETTING_KIND_STRING, { stringValue: 'metric' }],
      ['true', SETTING_KIND_BOOLEAN, { boolValue: true }],
      ['false', SETTING_KIND_BOOLEAN, { boolValue: false }],
      ['-42', SETTING_KIND_INTEGER, { intValue: -42 }],
      ['1.5', SETTING_KIND_FLOAT, { floatValue: 1.5 }],
    ];
    for (const [text, kind, value] of cases) {
      const typed = typedValueFromText(text, kind);
      expect(typed).toEqual(value);
      expect(textFromTypedValue(typed)).toBe(text);
    }
  });

  it('writes a string setting as text even when it looks like a number', () => {
    expect(typedValueFromText('42', SETTING_KIND_STRING)).toEqual({ stringValue: '42' });
    expect(typedValueFromText('true', SETTING_KIND_STRING)).toEqual({ stringValue: 'true' });
  });

  it('reads no value as undefined and an empty string as empty', () => {
    expect(textFromTypedValue(undefined)).toBeUndefined();
    expect(textFromTypedValue({})).toBeUndefined();
    expect(textFromTypedValue({ stringValue: undefined, boolValue: undefined })).toBeUndefined();

    const empty = typedValueFromText('', SETTING_KIND_STRING);
    expect(empty).toEqual({ stringValue: '' });
    expect(textFromTypedValue(empty)).toBe('');
  });

  it('reads an unset resolution as undefined', () => {
    const resolution: ResolvedSetting = {
      definition: undefined,
      value: undefined,
      typedValue: undefined,
      source: ValueSource.VALUE_SOURCE_UNSET,
    };

    expect(textFromTypedValue(resolution.typedValue)).toBeUndefined();
  });

  it('reads booleans as strconv.ParseBool does', () => {
    for (const text of ['true', 'True', 'TRUE', 't', 'T', '1']) {
      expect(typedValueFromText(text, SETTING_KIND_BOOLEAN)).toEqual({ boolValue: true });
    }
    for (const text of ['false', 'False', 'FALSE', 'f', 'F', '0']) {
      expect(typedValueFromText(text, SETTING_KIND_BOOLEAN)).toEqual({ boolValue: false });
    }
    expect(textFromTypedValue(typedValueFromText('True', SETTING_KIND_BOOLEAN))).toBe('true');
    for (const text of ['tRUE', 'yes', '', ' true', '2']) {
      expect(refusal(text, SETTING_KIND_BOOLEAN)).toMatchObject({
        reason: 'not-of-kind',
        text,
        kind: SETTING_KIND_BOOLEAN,
      });
    }
  });

  it('reads integers in base ten and refuses int64 overflow', () => {
    expect(typedValueFromText('+5', SETTING_KIND_INTEGER)).toEqual({ intValue: 5 });
    expect(textFromTypedValue(typedValueFromText('007', SETTING_KIND_INTEGER))).toBe('7');
    expect(textFromTypedValue(typedValueFromText('-0', SETTING_KIND_INTEGER))).toBe('0');
    for (const text of ['9223372036854775808', '-9223372036854775809', '1.0', '1_000', '0x10', '', '+', ' 1', '1e3']) {
      expect(refusal(text, SETTING_KIND_INTEGER)).toMatchObject({
        reason: 'not-of-kind',
        text,
        kind: SETTING_KIND_INTEGER,
      });
    }
  });

  it('refuses an int64 a number cannot hold exactly, apart from one that is not an integer', () => {
    expect(typedValueFromText('9007199254740991', SETTING_KIND_INTEGER)).toEqual({ intValue: Number.MAX_SAFE_INTEGER });
    expect(typedValueFromText('-9007199254740991', SETTING_KIND_INTEGER)).toEqual({
      intValue: Number.MIN_SAFE_INTEGER,
    });
    for (const text of ['9007199254740992', '-9007199254740992', '9223372036854775807', '-9223372036854775808']) {
      expect(refusal(text, SETTING_KIND_INTEGER)).toMatchObject({
        reason: 'unsafe-integer',
        text,
        kind: SETTING_KIND_INTEGER,
      });
    }
  });

  it('accepts non-finite floats as the server does', () => {
    expect(typedValueFromText('NaN', SETTING_KIND_FLOAT).floatValue).toBeNaN();
    expect(textFromTypedValue(typedValueFromText('nan', SETTING_KIND_FLOAT))).toBe('NaN');
    expect(typedValueFromText('inf', SETTING_KIND_FLOAT)).toEqual({ floatValue: Infinity });
    expect(textFromTypedValue(typedValueFromText('Inf', SETTING_KIND_FLOAT))).toBe('+Inf');
    expect(textFromTypedValue(typedValueFromText('-Infinity', SETTING_KIND_FLOAT))).toBe('-Inf');
    expect(textFromTypedValue(typedValueFromText('+Inf', SETTING_KIND_FLOAT))).toBe('+Inf');
    for (const text of ['-nan', '+NaN', 'infin', 'nan(1)', '1e400', '-1e400', '0x1p1024']) {
      expect(refusal(text, SETTING_KIND_FLOAT)).toMatchObject({
        reason: 'not-of-kind',
        text,
        kind: SETTING_KIND_FLOAT,
      });
    }
  });

  it('reads floats as strconv.ParseFloat does', () => {
    const accepted: [string, number][] = [
      ['.5', 0.5],
      ['5.', 5],
      ['-.5', -0.5],
      ['1E5', 100_000],
      ['1_000', 1000],
      ['1_000.000_1', 1000.0001],
      ['0x1p-2', 0.25],
      ['0X.8P1', 1],
      ['0x_1p0', 1],
      ['0x1.8p1', 3],
      ['-0x1p-1074', -5e-324],
      ['0x1p-1075', 0],
      ['0x1.000001p-1074', 5e-324],
      ['0x1.fffffffffffff8p0', 2],
      ['0x1.fffffffffffffp1023', Number.MAX_VALUE],
      ['2e-324', 0],
      ['0x0p0', 0],
      ['0x1p-2000', 0],
    ];
    for (const [text, number] of accepted) {
      expect(typedValueFromText(text, SETTING_KIND_FLOAT)).toEqual({ floatValue: number });
    }
    expect(Object.is(typedValueFromText('-0', SETTING_KIND_FLOAT).floatValue, -0)).toBe(true);
    for (const text of [
      '',
      '.',
      '+',
      '1e',
      '0x1.8',
      '0x1',
      '0xp1',
      '1__0',
      '1_',
      '_1',
      '1_.5',
      ' 1',
      '1,5',
      '0b1',
      'Infinityy',
    ]) {
      expect(refusal(text, SETTING_KIND_FLOAT)).toMatchObject({
        reason: 'not-of-kind',
        text,
        kind: SETTING_KIND_FLOAT,
      });
    }
  });

  it('writes floats as strconv.FormatFloat does', () => {
    const formatted: [number, string][] = [
      [0, '0'],
      [-0, '-0'],
      [1, '1'],
      [-2.5, '-2.5'],
      [123_456, '123456'],
      [1_000_000, '1e+06'],
      [1_234_567, '1.234567e+06'],
      [0.0001, '0.0001'],
      [0.00012, '0.00012'],
      [0.00001, '1e-05'],
      [1e21, '1e+21'],
      [5e-324, '5e-324'],
      [Number.MAX_VALUE, '1.7976931348623157e+308'],
    ];
    for (const [number, text] of formatted) {
      expect(textFromTypedValue({ floatValue: number })).toBe(text);
    }
  });

  it('refuses a kind with no value case, apart from text that is not of the kind', () => {
    expect(refusal('x', SettingKind.SETTING_KIND_UNSPECIFIED)).toMatchObject({
      reason: 'unknown-kind',
      kind: SettingKind.SETTING_KIND_UNSPECIFIED,
    });
    expect(refusal('x', SettingKind.UNRECOGNIZED)).toMatchObject({
      reason: 'unknown-kind',
      kind: SettingKind.UNRECOGNIZED,
    });
  });

  it("describes a refusal in the server's words", () => {
    expect(refusal('abc', SETTING_KIND_INTEGER).message).toBe('"abc" is not an integer');
    expect(refusal('yes', SETTING_KIND_BOOLEAN).message).toBe('"yes" is not a boolean');
    expect(refusal('x', SETTING_KIND_FLOAT).message).toBe('"x" is not a float');
    expect(refusal('9007199254740992', SETTING_KIND_INTEGER).message).toBe(
      '"9007199254740992" is an integer beyond what this client holds exactly',
    );
    expect(refusal('x', SettingKind.SETTING_KIND_UNSPECIFIED).message).toBe(
      'a setting of unspecified kind has no value this client can write',
    );
    expect(refusal('x', SettingKind.UNRECOGNIZED).message).toBe(
      'a setting of unrecognized (-1) kind has no value this client can write',
    );
    expect(refusal('x', SETTING_KIND_FLOAT).name).toBe('SettingValueError');
  });
});
