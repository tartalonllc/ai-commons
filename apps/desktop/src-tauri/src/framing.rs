//! Newline-delimited framing for the daemon's stdout, with a hard line-length cap.

use std::io::{self, BufRead};

/// Mirrors `DAEMON_MAX_LINE_BYTES` in apps/worker/src/daemon/protocol.ts.
pub const MAX_LINE_BYTES: usize = 1_000_000;

#[derive(Debug, PartialEq, Eq)]
pub enum Frame {
    Line(String),
    /// A line longer than the cap; its bytes were discarded.
    Oversized,
    Eof,
}

pub struct LineReader<R> {
    inner: R,
    max: usize,
}

impl<R: BufRead> LineReader<R> {
    pub fn new(inner: R, max: usize) -> Self {
        Self { inner, max }
    }

    pub fn next_frame(&mut self) -> io::Result<Frame> {
        let mut line: Vec<u8> = Vec::new();
        let mut oversized = false;
        loop {
            let (consumed, complete) = {
                let available = self.inner.fill_buf()?;
                if available.is_empty() {
                    return Ok(if oversized {
                        Frame::Oversized
                    } else if line.is_empty() {
                        Frame::Eof
                    } else {
                        Frame::Line(decode(&line))
                    });
                }
                let newline = available.iter().position(|&b| b == b'\n');
                let chunk = &available[..newline.unwrap_or(available.len())];
                if !oversized {
                    if line.len() + chunk.len() > self.max {
                        oversized = true;
                        line.clear();
                    } else {
                        line.extend_from_slice(chunk);
                    }
                }
                (
                    newline.map_or(available.len(), |i| i + 1),
                    newline.is_some(),
                )
            };
            self.inner.consume(consumed);
            if complete {
                return Ok(if oversized {
                    Frame::Oversized
                } else {
                    Frame::Line(decode(&line))
                });
            }
        }
    }
}

fn decode(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    text.strip_suffix('\r').unwrap_or(&text).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Cursor};

    fn frames(input: &str, max: usize) -> Vec<Frame> {
        let mut reader = LineReader::new(Cursor::new(input.as_bytes().to_vec()), max);
        let mut out = Vec::new();
        loop {
            let frame = reader.next_frame().unwrap();
            let end = frame == Frame::Eof;
            out.push(frame);
            if end {
                return out;
            }
        }
    }

    fn line(s: &str) -> Frame {
        Frame::Line(s.to_string())
    }

    #[test]
    fn splits_lines_and_strips_crlf() {
        assert_eq!(
            frames("a\r\nbc\n", 10),
            vec![line("a"), line("bc"), Frame::Eof]
        );
    }

    #[test]
    fn returns_a_trailing_partial_line() {
        assert_eq!(frames("a\nb", 10), vec![line("a"), line("b"), Frame::Eof]);
    }

    #[test]
    fn skips_oversized_lines_and_recovers() {
        assert_eq!(
            frames("0123456789AB\nok\n", 10),
            vec![Frame::Oversized, line("ok"), Frame::Eof]
        );
    }

    #[test]
    fn allows_a_line_of_exactly_the_cap() {
        assert_eq!(
            frames("0123456789\n", 10),
            vec![line("0123456789"), Frame::Eof]
        );
    }

    #[test]
    fn handles_lines_split_across_reads() {
        let inner = BufReader::with_capacity(4, Cursor::new(b"hello world\nx\n".to_vec()));
        let mut reader = LineReader::new(inner, 100);
        assert_eq!(reader.next_frame().unwrap(), line("hello world"));
        assert_eq!(reader.next_frame().unwrap(), line("x"));
        assert_eq!(reader.next_frame().unwrap(), Frame::Eof);
    }

    #[test]
    fn empty_input_is_eof() {
        assert_eq!(frames("", 10), vec![Frame::Eof]);
    }
}
