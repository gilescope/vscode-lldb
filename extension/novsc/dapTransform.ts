// SPDX-License-Identifier: MIT
//
// Variables-view §1.1–§1.6: stream-level transform that parses
// Content-Length-framed DAP messages flowing from the bs adapter
// to VS Code, gives a subclass a chance to mutate each message,
// and re-serialises with correct framing.
//
// Used by `varEnhancer.ts` to apply the bugstalker.* custom
// fields (storage, mutability, points_to_heap, byte_size,
// layout, recursionCount, stackHealth) to the visible value /
// name strings — without those mutations the VS Code stock
// variables pane has no way to surface them, since DAP's
// `presentationHint` only standardises italics for `readOnly`.
//
// DAP framing (per the spec):
//   Content-Length: <N>\r\n
//   \r\n
//   <N bytes of JSON body>
//
// Buffering rules: a chunk may carry a partial header, a header
// without its body, multiple complete messages, or a body split
// across chunks. The parser must handle all of these without
// losing bytes or framing.

import { Transform, TransformCallback } from 'node:stream';

/**
 * Anything matching the rough shape of a DAP message. Loose typing
 * because we mutate fields on responses whose body shape is
 * known only by `command`.
 */
export interface DapMessage {
    seq?: number;
    type?: 'request' | 'response' | 'event';
    command?: string;
    event?: string;
    success?: boolean;
    body?: any;
    [key: string]: any;
}

/**
 * Transform stream that parses inbound DAP framing, hands each
 * complete message to a `mutate` callback, and emits the
 * (possibly modified) message back out with correct framing.
 *
 * If `mutate` returns the message unchanged (or doesn't touch
 * anything observable on the wire), the re-serialised output may
 * differ byte-for-byte from the input — JSON key ordering /
 * whitespace get normalised. DAP clients don't care; they parse
 * the JSON. If you need byte-exact passthrough for non-response
 * messages, return the original buffer from a custom hook.
 *
 * Malformed bytes (a bad header, a JSON parse failure mid-body)
 * are forwarded unmodified to avoid breaking the session — the
 * downstream consumer will see the same garbage it would have
 * seen without us in the pipeline.
 */
export class DapMessageTransform extends Transform {
    private buf: Buffer = Buffer.alloc(0);
    private readonly mutate: (msg: DapMessage) => DapMessage | undefined;

    constructor(mutate: (msg: DapMessage) => DapMessage | undefined) {
        super();
        this.mutate = mutate;
    }

    override _transform(
        chunk: Buffer | string,
        _encoding: BufferEncoding,
        callback: TransformCallback,
    ): void {
        const incoming =
            typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        this.buf = Buffer.concat([this.buf, incoming]);
        try {
            this.flushMessages();
            callback();
        } catch (err) {
            callback(err as Error);
        }
    }

    override _flush(callback: TransformCallback): void {
        // Whatever's left in the buffer is incomplete. Push it
        // through as-is so the downstream consumer at least sees
        // it (rather than silently dropping bytes on adapter
        // shutdown).
        if (this.buf.length > 0) {
            this.push(this.buf);
            this.buf = Buffer.alloc(0);
        }
        callback();
    }

    /**
     * Repeatedly parse complete messages out of `this.buf` and
     * emit them via `push()`. Stops when there's not enough buffered
     * data for one more complete message (incomplete header, header
     * without full body, etc.).
     */
    private flushMessages(): void {
        // Each iteration tries to consume exactly one message from
        // the head of the buffer. If we can't, we leave the
        // remainder buffered and return — the next chunk will
        // complete it.
        // eslint-disable-next-line no-constant-condition
        while (true) {
            // Header ends at the first \r\n\r\n.
            const headerEnd = indexOfDoubleCrlf(this.buf);
            if (headerEnd < 0) return; // need more bytes for the header

            const headerBytes = this.buf.subarray(0, headerEnd);
            const contentLength = parseContentLength(headerBytes);
            if (contentLength === null) {
                // Unparseable header — forward what we have to keep
                // the session alive, then drop our buffer. The
                // adapter's framing is broken; we're not going to
                // fix it from here.
                this.push(this.buf);
                this.buf = Buffer.alloc(0);
                return;
            }

            const bodyStart = headerEnd + 4; // skip \r\n\r\n
            const totalMessageLen = bodyStart + contentLength;
            if (this.buf.length < totalMessageLen) return; // body incomplete

            const bodyBytes = this.buf.subarray(bodyStart, totalMessageLen);
            const remainder = this.buf.subarray(totalMessageLen);
            this.buf = Buffer.from(remainder); // detach from old buffer

            let parsed: DapMessage | undefined;
            try {
                parsed = JSON.parse(bodyBytes.toString('utf8')) as DapMessage;
            } catch {
                // JSON parse failure — forward the whole framed
                // message unmodified so the client can decide what
                // to do.
                this.push(this.buf.subarray(0, 0)); // no-op
                this.pushFramed(headerBytes, bodyBytes);
                continue;
            }

            const mutated = this.mutate(parsed) ?? parsed;
            this.pushSerialised(mutated);
        }
    }

    private pushSerialised(msg: DapMessage): void {
        const body = Buffer.from(JSON.stringify(msg), 'utf8');
        const header = Buffer.from(
            `Content-Length: ${body.length}\r\n\r\n`,
            'utf8',
        );
        this.push(Buffer.concat([header, body]));
    }

    private pushFramed(header: Buffer, body: Buffer): void {
        const sep = Buffer.from('\r\n\r\n', 'utf8');
        this.push(Buffer.concat([header, sep, body]));
    }
}

/**
 * Find the byte index where the first `\r\n\r\n` appears in `buf`,
 * or -1 if not yet present. Used to locate the end of a DAP header.
 */
function indexOfDoubleCrlf(buf: Buffer): number {
    // Buffer.indexOf accepts a Buffer needle.
    return buf.indexOf(Buffer.from('\r\n\r\n', 'utf8'));
}

/**
 * Parse the `Content-Length` field from a header block. DAP only
 * defines that one field as mandatory; we tolerate additional
 * headers (Content-Type etc.) by ignoring them.
 */
function parseContentLength(headerBytes: Buffer): number | null {
    const text = headerBytes.toString('utf8');
    for (const line of text.split('\r\n')) {
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const key = line.slice(0, colon).trim().toLowerCase();
        if (key !== 'content-length') continue;
        const value = line.slice(colon + 1).trim();
        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n) || n < 0) return null;
        return n;
    }
    return null;
}
