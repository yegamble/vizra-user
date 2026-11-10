#!/usr/bin/perl
# redact-artifacts.pl — THE LANE A UPLOAD GATE. Run by redact-artifacts.sh, which
# is the pinned `redact` step of .github/workflows/e2e.yml. Read the header of
# redact-artifacts.sh and AGENTS.md § Artifact privacy first.
#
# WHAT IT DOES, IN ORDER. Every step fails CLOSED: a read, write, directory or
# parse error exits non-zero, and the upload step, gated on this step having
# SUCCEEDED, publishes nothing (war-room rules R5, R6).
#
#   1. Refuse if the staging directory `e2e-artifacts/` already exists in any
#      form: whatever is in it would be published (exit 6).
#   2. Read ONE source file, `playwright-report/results.json`: `lstat` the
#      directory (a real directory, not a link), `chdir` into it and compare
#      dev/ino, open the file O_NOFOLLOW|O_NONBLOCK, `fstat` it (a regular file),
#      and read at most the size cap plus one byte (exits 3, 5, 4, 2).
#   3. Redact URL query strings and fragments with the shared programs of
#      e2e/harness/redaction-patterns.json, and empty HAR-shaped `queryString`
#      arrays, in memory.
#   4. Check the REDACTED bytes against every content rule below (exits 4, 1).
#   5. Create `e2e-artifacts/` and `e2e-artifacts/playwright-report/` one at a
#      time, each `lstat`-verified, and write the bytes O_CREAT|O_EXCL|O_NOFOLLOW.
#   6. As its last act, re-walk `e2e-artifacts/` and require EXACTLY what it
#      wrote: two directories and one regular file with one link, the same size
#      and the same sha256 as the checked bytes (exit 5).
#
# Nothing else is ever staged, so nothing else can be published: no trace, no
# HTML report, no HAR, no archive, no screenshot, no error-context.md, no file a
# spec wrote. That is the control. It does not detect them; it never copies them.
#
# A REFUSAL NAMES the file, the rule and (for the encoded-run rule) the alphabet,
# the run length and the byte offset. It never prints content: the job log is
# public.
#
# `--redact-stdin` is a filter mode for e2e/harness/redaction-corpus.test.ts: it
# applies exactly the step-3 redaction to stdin and writes stdout.
# `--verify-staging SHA256 SIZE` runs step 6 alone, for the unit test. Neither
# stages or publishes anything; the pinned step passes neither.
use strict;
use warnings;
use Fcntl qw(O_RDONLY O_WRONLY O_CREAT O_EXCL O_NOFOLLOW O_NONBLOCK :mode);
use Errno qw(ENOENT EEXIST ELOOP);
use FindBin ();
use JSON::PP ();
use Digest::SHA ();

my $STAGE      = 'e2e-artifacts';
my $SOURCE_DIR = 'playwright-report';
my $SOURCE     = 'results.json';
my $LABEL      = "$SOURCE_DIR/$SOURCE";

# THE SIZE CAP. A real red run of the whole lane measured 143,806 bytes with the
# harness's attachment bodies inline, and 61,518 bytes in the CI artifact of
# run 35536837315. 8 MiB is 58 times the larger.
my $MAX_BYTES = 8 * 1024 * 1024;

# THE ENCODED-RUN LIMIT, N. No maximal run of the base64, base64url or hex
# alphabet may be longer than this. Measured on real red runs (plan § B4): the
# longest legitimate run is Playwright's per-test output directory name inside
# `attachments[].path`, 60 (trimLongString) + 1 + 21 ("desktop-chromium-1440")
# + 7 ("-retry1") = 89. `e2e/harness/upload-gate-allowlist.test.ts` derives that
# sum from the project names and the CI retry count and fails if it exceeds N.
# An unbroken base64 or base64url run of 67 bytes or more, or hex of 45 bytes or
# more, is longer than 89 characters. Data written WITH separators, or smaller,
# is not caught: AGENTS.md § Artifact privacy, residual R-A.
my $N = 89;
# Hex is checked FIRST only so that a hex run is NAMED as hex: every hex
# character is also in both base64 alphabets, so a hex run over N would be
# refused as base64 anyway.
my @ALPHABETS = (
  [ 'hex',       qr/[0-9A-Fa-f]{90,}/ ],
  [ 'base64',    qr/[A-Za-z0-9+\/]{90,}/ ],
  [ 'base64url', qr/[A-Za-z0-9_-]{90,}/ ],
);
die "redact-artifacts: N and the alphabet patterns disagree\n" unless $N + 1 == 90;

# --- the redaction programs, shared with e2e/harness/redact.ts ---------------
my @PROGRAMS;
{
  my $patterns = "$FindBin::RealBin/../../e2e/harness/redaction-patterns.json";
  open(my $fh, '<', $patterns) or fail_io("read the redaction patterns (e2e/harness/redaction-patterns.json)");
  local $/;
  my $doc = JSON::PP::decode_json(<$fh>);
  close($fh);
  # `<<NAME>>` is the fragment of that name, declared above its first use;
  # e2e/harness/redact.ts expands them the same way. Unknown names die.
  my %frag;
  my $expand = sub {
    my $p = shift;
    $p =~ s/<<([A-Za-z0-9_]+)>>/exists $frag{$1} ? $frag{$1} : die "redaction patterns: unknown fragment $1\n"/ge;
    die "redaction patterns: unexpanded placeholder in $p\n" if index($p, '<<') >= 0;
    $p;
  };
  $frag{ $_->{name} } = $expand->($_->{pattern}) for @{ $doc->{fragments} // [] };
  @PROGRAMS = map { my $p = $expand->($_->{pattern}); ($_->{flags} // '') =~ /i/ ? qr/$p/i : qr/$p/ } @{ $doc->{programs} };
  die "redaction patterns: no programs\n" unless @PROGRAMS;
}

# redact BYTES -> BYTES. The four URL programs in order, then the HAR program:
# a HAR stores the query a second time, parsed into fields, which no URL rewrite
# reaches, so the array is emptied.
sub redact {
  my ($s) = @_;
  for my $re (@PROGRAMS) { $s =~ s/$re/$1?<redacted>/g }
  $s =~ s{"queryString":\[[^\]]*\]}{"queryString":[]}g;
  return $s;
}

sub fail_io {
  my ($what) = @_;
  my $why = "$!";
  print STDERR "::error::redact-artifacts: could not $what ($why). A gate that cannot read or write is not a pass. Nothing will be uploaded.\n";
  exit 2;
}

sub refuse {
  my ($code, $rule) = @_;
  print STDERR "::error::redact-artifacts: $LABEL is refused: $rule. Nothing will be uploaded.\n";
  print STDERR "  See AGENTS.md § Artifact privacy, \"What the gate refuses, exactly\".\n";
  exit $code;
}

# verify_staging SHA256 SIZE [DIR-IDS] — the gate's last act (security seat S-5).
# `e2e-artifacts/` must hold exactly two real directories and one regular file
# with one link, of SIZE bytes and this SHA256; with DIR-IDS, each directory must
# still be the one this gate created (same dev/ino). Anything else exits 5. It
# only reads. `--verify-staging SHA256 SIZE` runs it alone, for the unit test.
sub verify_staging {
  my ($want_sha, $want_size, $ids) = @_;
  my @expect = (
    [ $STAGE,                       'dir',  $ids ? $ids->[0] : undef ],
    [ "$STAGE/$SOURCE_DIR",         'dir',  $ids ? $ids->[1] : undef ],
    [ "$STAGE/$SOURCE_DIR/$SOURCE", 'file', undef ],
  );
  for my $entry (@expect) {
    my ($name, $kind, $id) = @$entry;
    my @s = lstat($name);
    refuse(5, "$name is missing from the staging directory after it was written") unless @s;
    if ($kind eq 'dir') {
      refuse(5, "$name is not a real directory") unless S_ISDIR($s[2]);
      refuse(5, "$name is no longer the directory this gate made") if $id && !($s[0] == $id->[0] && $s[1] == $id->[1]);
      opendir(my $dh, $name) or fail_io("list $name");
      my @names = sort grep { $_ ne '.' && $_ ne '..' } readdir($dh);
      closedir($dh);
      my $only = $name eq $STAGE ? $SOURCE_DIR : $SOURCE;
      refuse(5, "$name holds something this gate did not write") unless @names == 1 && $names[0] eq $only;
    } else {
      refuse(5, "$name is not a regular file with one link") unless S_ISREG($s[2]) && $s[3] == 1;
      refuse(5, "$name changed size after it was written") unless $s[7] == $want_size;
      my $fh;
      sysopen($fh, $name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK) or fail_io("re-read $name");
      my $back = '';
      while (1) {
        my $got = sysread($fh, $back, 65536, length($back));
        defined $got or fail_io("re-read $name");
        last if $got == 0;
      }
      close($fh);
      refuse(5, "$name changed after it was written (sha256 differs)") unless Digest::SHA::sha256_hex($back) eq $want_sha;
    }
  }
  return 1;
}

# --- filter and verify modes -----------------------------------------------------
if (@ARGV == 3 && $ARGV[0] eq '--verify-staging') {
  verify_staging($ARGV[1], $ARGV[2], undef);
  print STDOUT "OK: $STAGE/ holds exactly $LABEL, as expected.\n";
  exit 0;
}
if (@ARGV == 1 && $ARGV[0] eq '--redact-stdin') {
  binmode(STDIN);
  binmode(STDOUT);
  local $/;
  my $in = <STDIN>;
  $in = '' unless defined $in;
  (print STDOUT redact($in)) or fail_io('write stdout');
  exit 0;
}
if (@ARGV) {
  print STDERR "::error::redact-artifacts: takes no arguments (it stages exactly $LABEL into $STAGE/). Nothing will be uploaded.\n";
  exit 2;
}

# --- 1. the staging directory must not exist ----------------------------------
opendir(my $home, '.') or fail_io('open the working directory');
my @home_id = (stat($home))[0, 1];
@home_id == 2 or fail_io('stat the working directory');
if (!lstat($STAGE)) {
  fail_io("lstat $STAGE") unless $! == ENOENT;
} else {
  print STDERR "::error::redact-artifacts: $STAGE/ already exists. It must not exist before this step: whatever is in it would be published. Nothing will be uploaded.\n";
  exit 6;
}

# --- 2. read the one source file -------------------------------------------
my @dir = lstat($SOURCE_DIR);
if (!@dir) {
  if ($! == ENOENT) {
    print STDERR "::error::redact-artifacts: $LABEL does not exist, so there is nothing to stage. The lane failed before its JSON report was written; its own step log carries the failure. Nothing will be uploaded.\n";
    exit 3;
  }
  fail_io("lstat $SOURCE_DIR");
}
refuse(5, "$SOURCE_DIR is not a real directory (a symbolic link or another file type)") unless S_ISDIR($dir[2]);
chdir($SOURCE_DIR) or fail_io("enter $SOURCE_DIR");
my @here = stat('.');
@here or fail_io("stat $SOURCE_DIR");
refuse(5, "$SOURCE_DIR changed while it was being read") unless $here[0] == $dir[0] && $here[1] == $dir[1];

my $in;
if (!sysopen($in, $SOURCE, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)) {
  if ($! == ENOENT) {
    print STDERR "::error::redact-artifacts: $LABEL does not exist, so there is nothing to stage. The lane failed before its JSON report was written; its own step log carries the failure. Nothing will be uploaded.\n";
    exit 3;
  }
  refuse(5, 'it is a symbolic link') if $! == ELOOP;
  fail_io("open $LABEL");
}
my @st = stat($in);
@st or fail_io("fstat $LABEL");
refuse(5, 'it is not a regular file') unless S_ISREG($st[2]);
refuse(4, "it is larger than the size cap ($st[7] bytes, cap $MAX_BYTES)") if $st[7] > $MAX_BYTES;
my $raw = '';
while (1) {
  my $got = sysread($in, $raw, 65536, length($raw));
  defined $got or fail_io("read $LABEL");
  last if $got == 0;
  refuse(4, "it grew past the size cap while it was read (cap $MAX_BYTES)") if length($raw) > $MAX_BYTES;
}
close($in) or fail_io("close $LABEL");
chdir($home) or fail_io('return to the working directory');
{
  my @back = stat('.');
  refuse(5, 'the working directory changed while the file was read') unless @back && $back[0] == $home_id[0] && $back[1] == $home_id[1];
}

# --- 3. redact ------------------------------------------------------------------
my $bytes = redact($raw);

# --- 4. the content rules, on the REDACTED bytes ------------------------------
# Strict UTF-8: no overlong form, no surrogate, nothing above U+10FFFF. A `\G`
# loop rather than one quantified group, which Perl caps at 32,766 repetitions.
{
  pos($bytes) = 0;
  while ($bytes =~ /\G(?:[\x00-\x7F]+|[\xC2-\xDF][\x80-\xBF]|\xE0[\xA0-\xBF][\x80-\xBF]|[\xE1-\xEC\xEE\xEF][\x80-\xBF]{2}|\xED[\x80-\x9F][\x80-\xBF]|\xF0[\x90-\xBF][\x80-\xBF]{2}|[\xF1-\xF3][\x80-\xBF]{3}|\xF4[\x80-\x8F][\x80-\xBF]{2})/gc) { }
  my $valid = pos($bytes) // 0;
  refuse(4, "it is not valid UTF-8 (the first invalid byte is at offset $valid)") if $valid != length($bytes);
}
# No control character but TAB and LF: C0, DEL, and C1 (U+0080-U+009F).
if ($bytes =~ /[\x00-\x08\x0B-\x1F\x7F]/) {
  refuse(4, sprintf('it holds a control byte 0x%02X at offset %d (only TAB and LF are allowed)', ord(substr($bytes, $-[0], 1)), $-[0]));
}
if ($bytes =~ /\xC2[\x80-\x9F]/) {
  refuse(4, "it holds a C1 control character at offset $-[0]");
}
# The encoded-run rule: no run of one alphabet longer than N.
for my $alphabet (@ALPHABETS) {
  my ($name, $re) = @$alphabet;
  if ($bytes =~ $re) {
    my ($at, $len) = ($-[0], $+[0] - $-[0]);
    refuse(4, "it holds a run of $len $name-alphabet characters at byte offset $at, longer than the limit of $N (encoded binary is not published)");
  }
}
# It is JSON, and it carries no page snapshot, no matcher snapshot and no git data.
my $doc = eval { JSON::PP->new->utf8->decode($bytes) };
refuse(4, 'it does not parse as JSON') unless defined $doc;
{
  my @stack = ($doc);
  while (@stack) {
    my $node = pop @stack;
    if (ref $node eq 'HASH') {
      for my $key (keys %$node) {
        refuse(1, 'it carries an `errorContext` key (a matcher aria snapshot of the page)') if $key eq 'errorContext';
        push @stack, $key, $node->{$key};
      }
    } elsif (ref $node eq 'ARRAY') {
      push @stack, @$node;
    } elsif (defined $node && !ref $node) {
      if ($node =~ /^# Page snapshot$/m) {
        refuse(1, 'it carries a `# Page snapshot` section (an aria snapshot of the live page)');
      }
      if ($node =~ /^\s*```yaml/m) {
        refuse(1, 'it carries a ```yaml block (the shape of an aria snapshot of the page)');
      }
    }
  }
  my $metadata = ref $doc eq 'HASH' && ref $doc->{config} eq 'HASH' ? $doc->{config}{metadata} : undef;
  if (ref $metadata eq 'HASH') {
    for my $key (qw(gitDiff gitCommit)) {
      refuse(4, "it carries config.metadata.$key (playwright.config.ts must set captureGitInfo: { commit: false, diff: false })") if exists $metadata->{$key};
    }
  }
}

# --- 5. write the staging directory ----------------------------------------
my @made;
sub make_dir {
  my ($name) = @_;
  if (!mkdir($name, 0755)) {
    if ($! == EEXIST) {
      print STDERR "::error::redact-artifacts: $name appeared while this gate ran. Nothing will be uploaded.\n";
      exit 6;
    }
    fail_io("create $name");
  }
  my @s = lstat($name);
  @s or fail_io("lstat $name");
  refuse(5, "the staging directory $name is not the real directory this gate made") unless S_ISDIR($s[2]);
  chdir($name) or fail_io("enter $name");
  my @in = stat('.');
  refuse(5, "the staging directory $name changed while it was written") unless @in && $in[0] == $s[0] && $in[1] == $s[1];
  push @made, [ $s[0], $s[1] ];
}
make_dir($STAGE);
make_dir($SOURCE_DIR);
my $out;
sysopen($out, $SOURCE, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0644) or fail_io("create $STAGE/$LABEL");
{
  my $offset = 0;
  while ($offset < length($bytes)) {
    my $wrote = syswrite($out, $bytes, length($bytes) - $offset, $offset);
    defined $wrote or fail_io("write $STAGE/$LABEL");
    $offset += $wrote;
  }
}
close($out) or fail_io("close $STAGE/$LABEL");
chdir($home) or fail_io('return to the working directory');

# --- 6. re-walk: exactly what was written, and nothing else -------------------
verify_staging(Digest::SHA::sha256_hex($bytes), length($bytes), \@made);

printf STDOUT "OK: staged %s (%d bytes, URL query strings redacted; UTF-8, no control bytes, no encoded run longer than %d, JSON, no page or matcher snapshot, no git metadata) into %s/. Nothing else is staged, and the upload reads only %s/.\n",
  $LABEL, length($bytes), $N, $STAGE, $STAGE;
exit 0;
