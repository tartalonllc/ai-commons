import { describe, expect, it } from 'vitest';
import { DAEMON_MAX_LINE_BYTES, parseRequestLine } from '../src/daemon/protocol.js';

describe('parseRequestLine', () => {
  it('accepts a valid request', () => {
    expect(parseRequestLine('{"id":"1","method":"setMode","params":{"mode":"paused"}}')).toEqual({
      ok: true,
      id: '1',
      method: 'setMode',
      params: { mode: 'paused' },
    });
  });

  it('treats missing params as an empty object', () => {
    expect(parseRequestLine('{"id":"2","method":"getStatus"}')).toEqual({
      ok: true,
      id: '2',
      method: 'getStatus',
      params: {},
    });
  });

  it('rejects non-JSON with a null id', () => {
    expect(parseRequestLine('hello')).toMatchObject({ ok: false, id: null, code: 'bad_request' });
  });

  it('rejects oversized lines', () => {
    const line = JSON.stringify({
      id: '3',
      method: 'getStatus',
      params: { pad: 'x'.repeat(DAEMON_MAX_LINE_BYTES) },
    });
    expect(parseRequestLine(line)).toMatchObject({ ok: false, id: null, code: 'bad_request' });
  });

  it('rejects unknown methods, including inherited property names', () => {
    expect(parseRequestLine('{"id":"4","method":"formatDisk"}')).toMatchObject({
      ok: false,
      id: '4',
      code: 'unknown_method',
    });
    expect(parseRequestLine('{"id":"5","method":"toString"}')).toMatchObject({
      ok: false,
      code: 'unknown_method',
    });
  });

  it('rejects invalid params and reports the path', () => {
    const result = parseRequestLine('{"id":"6","method":"setMode","params":{"mode":"turbo"}}');
    expect(result).toMatchObject({ ok: false, id: '6', code: 'bad_request' });
    expect(result.ok ? '' : result.message).toContain('/mode');
  });

  it('rejects unexpected envelope fields and overlong keys', () => {
    expect(parseRequestLine('{"id":"7","method":"getStatus","extra":1}')).toMatchObject({
      ok: false,
      id: '7',
      code: 'bad_request',
    });
    const key = 'k'.repeat(5000);
    expect(
      parseRequestLine(
        JSON.stringify({ id: '8', method: 'setKey', params: { provider: 'openai', key } }),
      ),
    ).toMatchObject({ ok: false, code: 'bad_request' });
  });

  it('narrows params by method without a cast', () => {
    const req = parseRequestLine('{"id":"9","method":"setMode","params":{"mode":"paused"}}');
    if (!req.ok) throw new Error('expected ok');
    switch (req.method) {
      case 'setMode':
        expect(req.params.mode).toBe('paused');
        break;
      default:
        throw new Error(`unexpected method ${req.method}`);
    }
  });

  it('treats null params as an empty object', () => {
    expect(parseRequestLine('{"id":"10","method":"getStatus","params":null}')).toEqual({
      ok: true,
      id: '10',
      method: 'getStatus',
      params: {},
    });
  });

  it('rejects prototype-polluting params', () => {
    const line = '{"id":"11","method":"getStatus","params":{"__proto__":{"x":1}}}';
    // JSON.parse creates an own "__proto__" data property here (it does not
    // reach the object's prototype), so this exercises additionalProperties.
    expect(Object.hasOwn(JSON.parse(line).params, '__proto__')).toBe(true);
    expect(parseRequestLine(line)).toMatchObject({ ok: false, id: '11', code: 'bad_request' });
  });

  describe('never echoes a rejected secret', () => {
    const sentinel = 'sk-SENTINEL-' + 'z'.repeat(5000);

    it('rejects an oversized key', () => {
      const result = parseRequestLine(
        JSON.stringify({
          id: '12',
          method: 'setKey',
          params: { provider: 'openai', key: sentinel },
        }),
      );
      expect(result).toMatchObject({ ok: false, code: 'bad_request' });
      expect(result.ok ? '' : result.message).not.toContain('SENTINEL');
    });

    it('rejects a numeric key', () => {
      const result = parseRequestLine(
        JSON.stringify({ id: '13', method: 'setKey', params: { provider: 'openai', key: 12345 } }),
      );
      expect(result).toMatchObject({ ok: false, code: 'bad_request' });
      expect(result.ok ? '' : result.message).not.toContain('SENTINEL');
    });

    it('rejects a misnamed key property', () => {
      const result = parseRequestLine(
        JSON.stringify({
          id: '14',
          method: 'setKey',
          params: { provider: 'openai', apiKey: sentinel },
        }),
      );
      expect(result).toMatchObject({ ok: false, code: 'bad_request' });
      expect(result.ok ? '' : result.message).not.toContain('SENTINEL');
    });

    it('rejects a key swapped into provider', () => {
      const result = parseRequestLine(
        JSON.stringify({
          id: '15',
          method: 'setKey',
          params: { provider: sentinel, key: 'anything' },
        }),
      );
      expect(result).toMatchObject({ ok: false, code: 'bad_request' });
      expect(result.ok ? '' : result.message).not.toContain('SENTINEL');
    });
  });
});
