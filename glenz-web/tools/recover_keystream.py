#!/usr/bin/env python3
"""Recover Future Crew's music-protection XOR keystream from the scrambled
S3M files alone — no clean reference file needed.

Second Reality's MUSIC0.S3M / MUSIC1.S3M ship with their pattern data XORed
with a fixed keystream that restarts at every pattern (the descrambler lives
inside FC's private STMIK player build; played raw the files are noise).
Because the keystream is shared by all 154 patterns across the two files,
and S3M packed pattern data is a walkable state machine with tightly
constrained byte values, the keystream falls to plain constraint
propagation:

  1. If keystream bytes 0..i-1 are known, the exact parse state (which
     field comes next: WHAT/NOTE/INS/VOL/CMD/INFO) of every pattern at
     position i is known.
  2. Each pattern p constrains k(i) to { scrambled_p(i) ^ v : v legal for
     p's current field }:
       WHAT  0 (end of row), or channel|flag byte with nonzero flag bits
       NOTE  254, 255, or hi-nibble octave <=9 with lo-nibble semitone <=11
       INS   0..insnum (insnum comes from the unscrambled file header)
       VOL   0..64
       CMD   0..26 (effect letters A..Z)
       INFO  unconstrained
     A pattern must also parse exactly: 64 rows consuming exactly its
     stored packed length.
  3. Intersecting candidates over all patterns alive at position i nearly
     always leaves a single k(i). The positions with 2+ locally-valid
     values are carried as parallel hypotheses (a beam); a wrong choice
     drives some pattern into an illegal state within a few bytes and that
     branch dies. The recovered keystream is the longest common prefix all
     surviving beam hypotheses agree on — every byte in it is forced by the
     scrambled data. It runs out only in the tail, where so few patterns
     are still long enough to constrain a position that the true byte is
     genuinely undetermined by these two files (by then the keystream's
     closed form is confirmed over a thousand times).

The recovered keystream matches the closed form (i = byte index within a
pattern's packed data, after the 2-byte length word):

    n = (i >> 1) + 1
    k(i) = (((n ^ (n >> 2)) << 3) | ((5*i + 2) & 7)) & 0xFF

which is what glenz-web/main.js uses to descramble assets/music1.s3m
(a verbatim copy of MAIN/MUSIC1.S3M) at load time. As a final check this
script descrambles every pattern of both files with the closed form and
re-validates the full parse — all 64 rows, every field in range, every
pattern consuming exactly its stored length.

Usage: recover_keystream.py [repo_root]  (default: ../..)
"""
import struct
import sys
import os

WHAT, NOTE, INS, VOL, CMD, INFO, DONE = range(7)

NOTE_OK = frozenset({254, 255} | {(o << 4) | n for o in range(10) for n in range(12)})
VOL_OK = frozenset(range(65))
CMD_OK = frozenset(range(27))


class Walker:
    """Parse state of one pattern's packed data stream."""
    __slots__ = ("data", "ins_ok", "what_ok", "state", "row", "pending")

    def __init__(self, data, ins_ok, what_ok):
        self.data = data
        self.ins_ok = ins_ok
        self.what_ok = what_ok
        self.state = WHAT
        self.row = 0
        self.pending = ()

    def clone(self):
        w = object.__new__(Walker)
        w.data, w.ins_ok, w.what_ok = self.data, self.ins_ok, self.what_ok
        w.state, w.row, w.pending = self.state, self.row, self.pending
        return w

    def legal(self):
        s = self.state
        if s == WHAT:
            return self.what_ok
        if s == NOTE:
            return NOTE_OK
        if s == INS:
            return self.ins_ok
        if s == VOL:
            return VOL_OK
        if s == CMD:
            return CMD_OK
        return None  # INFO

    def advance(self, i, k):
        """Consume plaintext byte data[i]^k. False = format violation."""
        if self.state == DONE:
            return i >= len(self.data)      # trailing bytes would be junk
        if i >= len(self.data):
            return False                    # ran out before 64 rows
        v = self.data[i] ^ k
        s = self.state
        if s == WHAT:
            if v not in self.what_ok:
                return False
            if v == 0:
                self.row += 1
                if self.row == 64:
                    if i + 1 != len(self.data):
                        return False        # must consume exactly
                    self.state = DONE
                return True
            pend = []
            if v & 32:
                pend += [NOTE, INS]
            if v & 64:
                pend += [VOL]
            if v & 128:
                pend += [CMD, INFO]
            self.state = pend[0]
            self.pending = tuple(pend[1:])
            return True
        if s == NOTE and v not in NOTE_OK:
            return False
        if s == INS and v not in self.ins_ok:
            return False
        if s == VOL and v > 64:
            return False
        if s == CMD and v > 26:
            return False
        if self.pending:
            self.state = self.pending[0]
            self.pending = self.pending[1:]
        else:
            self.state = WHAT
        return True


def load_patterns(path):
    d = open(path, "rb").read()
    assert d[0x2C:0x30] == b"SCRM", f"{path}: not an S3M"
    ordnum, insnum, patnum = struct.unpack_from("<HHH", d, 0x20)
    # NB: don't restrict channels to the header table — ST3 keeps data for
    # muted/removed channels in the file (these songs use ch 10-14 that way)
    ins_ok = frozenset(range(insnum + 1))
    what_ok = frozenset({0} | {w for w in range(1, 256) if w & 0xE0})
    off = 0x60 + ordnum + insnum * 2
    out = []
    for p in range(patnum):
        ptr = struct.unpack_from("<H", d, off + p * 2)[0] * 16
        if ptr == 0:
            continue
        ln = struct.unpack_from("<H", d, ptr)[0]
        out.append(Walker(d[ptr + 2:ptr + ln], ins_ok, what_ok))
    return out


def candidates(walkers, i):
    """Intersection of keystream candidates at position i; None = no constraint."""
    cands = None
    for w in walkers:
        if w.state == DONE or i >= len(w.data):
            continue
        legal = w.legal()
        if legal is None:
            continue
        d = w.data[i]
        if cands is None:
            cands = {d ^ v for v in legal}
        else:
            cands = {k for k in cands if (d ^ k) in legal}
        if not cands:
            return set()
    return cands


def common_prefix(hyps):
    """Longest keystream prefix on which every hypothesis agrees. Because the
    true keystream is never dropped from the beam, and every survivor agrees
    on these bytes, each byte in the prefix equals the true keystream byte."""
    out = []
    for col in zip(*(h[0] for h in hyps)):
        if len(set(col)) != 1:
            break
        out.append(col[0])
    return out


def recover(walkers, maxlen, beam_cap=8192, min_alive=3):
    """Beam over (keystream prefix, walker states). A branch is dropped only
    when it CONTRADICTS (empty candidate set) — never when merely
    unconstrained — so the true keystream always survives. Returns the
    longest prefix every survivor agrees on: the bytes the data forces."""
    # a valid pattern consumes exactly its packed length, so pattern p
    # constrains exactly positions 0..len-1 (static, choice-independent).
    alive_at = [0] * (maxlen + 1)
    for w in walkers:
        alive_at[len(w.data)] += 1
    running = len(walkers)
    for i in range(maxlen + 1):
        n, alive_at[i] = alive_at[i], running
        running -= n

    beam = [([], walkers)]
    forks = 0
    stop = maxlen
    for i in range(maxlen):
        if alive_at[i] < min_alive:
            stop = i                        # tail: too few patterns constrain
            break
        nxt = []
        forked = False
        for ks, cur in beam:
            cands = candidates(cur, i)
            if cands is None:
                stop = i                    # unconstrained here: stop cleanly
                return common_prefix(beam), forks, len(beam), stop
            if not cands:
                continue                    # contradiction: drop this branch
            if len(cands) > 1:
                forked = True
            for k in sorted(cands):
                w2 = [w.clone() for w in cur] if len(cands) > 1 else cur
                if all(w.advance(i, k) for w in w2):
                    nxt.append((ks + [k], w2))
        forks += forked
        if not nxt:
            raise SystemExit(f"beam emptied at position {i}: model bug")
        if len(nxt) > beam_cap:
            stop = i                         # ambiguity outgrew the beam
            break
        beam = nxt
    return common_prefix(beam), forks, len(beam), stop


def formula(i):
    n = (i >> 1) + 1
    return (((n ^ (n >> 2)) << 3) | ((5 * i + 2) & 7)) & 0xFF


def validate_with_formula(walkers):
    bad = 0
    for w0 in walkers:
        w = w0.clone()
        if not all(w.advance(i, formula(i)) for i in range(len(w.data))) or w.state != DONE:
            bad += 1
    return bad


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "..")
    walkers = []
    for f in ("MUSIC0.S3M", "MUSIC1.S3M"):
        loaded = load_patterns(os.path.join(root, "MAIN", f))
        print(f"{f}: {len(loaded)} patterns", flush=True)
        walkers += loaded
    maxlen = max(len(w.data) for w in walkers)
    print(f"recovering keystream across {len(walkers)} patterns, {maxlen} positions...",
          flush=True)
    ks, forks, width, stop = recover([w.clone() for w in walkers], maxlen)
    print(f"recovered {len(ks)} keystream bytes with zero external reference "
          f"({forks} positions needed >1 hypothesis; {width} survivor(s); "
          f"tail from byte {stop} left undetermined by these 2 files)")
    mismatch = [i for i, k in enumerate(ks) if k != formula(i)]
    if mismatch:
        print(f"!! closed form differs at {len(mismatch)} positions: {mismatch[:10]}")
    else:
        print(f"all {len(ks)} recovered bytes match the closed form "
              "k(i) = ((n^(n>>2))<<3 | (5i+2)&7), n=(i>>1)+1")
    bad = validate_with_formula(walkers)
    print(f"full-parse validation of all patterns with closed form: "
          f"{len(walkers) - bad}/{len(walkers)} parse perfectly "
          f"(64 rows, exact length, all fields in range)")
    print("first 32 bytes:", " ".join(f"{k:02x}" for k in ks[:32]))


if __name__ == "__main__":
    main()
