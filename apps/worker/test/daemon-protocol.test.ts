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

  it('rejects oversized lines before parsing them', () => {
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
      code: 'bad_request',
    });
    const key = 'k'.repeat(5000);
    expect(
      parseRequestLine(
        JSON.stringify({ id: '8', method: 'setKey', params: { provider: 'openai', key } }),
      ),
    ).toMatchObject({ ok: false, code: 'bad_request' });
  });
});
