#!/usr/bin/env node
/**
 * Secret-scan script — detects common secrets accidentally committed to the repo.
 * Run manually or from CI:
 *   node scripts/scan-secrets.js
 *
 * Exits with code 1 if any potential secret is found.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');

// Patterns that indicate a secret may be present
const SECRET_PATTERNS = [
  // High-confidence patterns (almost certainly a secret)
  { pattern: /(?:password|passwd|pwd|secret|api[_-]?key|apikey|private[_-]?key)\s*[:=]\s*['"](?!\{)(?![A-Z_]{4,}['"])[^'"]{8,}['"]/gi, level: 'high', label: 'Hardcoded credential' },
  { pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/gi, level: 'high', label: 'Private key block' },
  { pattern: /ya29\.[0-9A-Za-z\-_]+/g, level: 'high', label: 'Google OAuth access token' },
  { pattern: /sk-[a-zA-Z0-9]{32,}/g, level: 'high', label: 'OpenAI/Stripe-style secret key' },
  { pattern: /AKIA[0-9A-Z]{16}/g, level: 'high', label: 'AWS access key ID' },
  { pattern: /[Jj][Ww][Tt][-_]?[Ss][Ee][Cc][Rr][Ee][Tt]\s*[:=]\s*['"][^'"]{8,}['"]/gi, level: 'high', label: 'JWT secret in config' },
  { pattern: /MONGO(?:DB)?[_-]?URI\s*[:=]\s*['"]mongodb(?:\+srv)?:\/\/[^:]+:[^@]+@/gi, level: 'high', label: 'MongoDB URI with credentials' },
  { pattern: /REDIS(?:CLOUD)?[_-]?URL\s*[:=]\s*['"]redis:\/\/[^:]+:[^@]+@/gi, level: 'high', label: 'Redis URL with credentials' },
  { pattern: /SMTP[_-]?PASS\s*[:=]\s*['"][^'"]+/gi, level: 'high', label: 'SMTP password in code' },

  // Medium-confidence patterns (could be false positive)
  { pattern: /['"][a-f0-9]{64}['"]/gi, level: 'medium', label: '64-char hex string (possible API key)' },
  { pattern: /['"][A-Za-z0-9+/]{40,}={0,2}['"]/g, level: 'medium', label: 'Base64 string (possible token)' },

  // File-based checks (handled separately)
];

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'coverage',
  'tmp',
  'secure',
  'logs',
  '.claude',
]);

const EXCLUDED_EXTENSIONS = new Set([
  '.xlsx',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.webp',
  '.mp4',
  '.mov',
  '.webm',
  '.pdf',
  '.gz',
  '.zip',
  '.lock',
  '.map',
]);

// Files expected to contain test/demo credentials (not real secrets)
const ALLOWED_CREDENTIAL_FILES = new Set([
  'scripts/seed.js',
  'scripts/seed.ts',
  '.env.example',
]);

// Files the gitignore system should protect — scanning them is redundant
function loadGitignorePatterns() {
  const patterns = [];
  const gitignorePath = path.join(PROJECT_ROOT, '.gitignore');
  let content;
  try {
    content = fs.readFileSync(gitignorePath, 'utf-8');
  } catch {
    return patterns;
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      patterns.push(trimmed);
    }
  }
  return patterns;
}

function isGitignored(relativePath) {
  // Simple check: if path starts with or contains a gitignored directory
  const segments = relativePath.replace(/\\/g, '/').split('/');
  for (const pattern of GITIGNORE_PATTERNS) {
    const cleanPattern = pattern.replace(/\/+$/, '');
    if (relativePath.startsWith(cleanPattern + '/') || relativePath === cleanPattern) {
      return true;
    }
    if (pattern.startsWith('*.') && relativePath.endsWith(pattern.substring(1))) {
      return true;
    }
    // Check directory segments
    for (const seg of segments) {
      if (seg === cleanPattern || (pattern.startsWith('*.') && seg.endsWith(pattern.substring(1)))) {
        return true;
      }
    }
  }
  return false;
}

let GITIGNORE_PATTERNS = [];

function shouldExcludeDir(dirname) {
  return EXCLUDED_DIRS.has(dirname);
}

function shouldExcludeFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return EXCLUDED_EXTENSIONS.has(ext);
}

function walkDir(dir, fileList = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return fileList;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!shouldExcludeDir(entry.name)) {
        walkDir(fullPath, fileList);
      }
    } else if (entry.isFile() && !shouldExcludeFile(fullPath)) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

function checkFileForSecrets(filePath) {
  const findings = [];
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return findings;
  }

  const relativePath = path.relative(PROJECT_ROOT, filePath);

  for (const { pattern, level, label } of SECRET_PATTERNS) {
    // Reset regex state
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const lineNumber = content.substring(0, match.index).split('\n').length;
      const context = match[0].length > 80
        ? match[0].substring(0, 80) + '...'
        : match[0];
      findings.push({ file: relativePath, line: lineNumber, level, label, context });
    }
  }

  return findings;
}

// Check for sensitive files that should be gitignored
function checkSensitiveFiles() {
  const findings = [];
  const sensitiveFilePatterns = [
    { glob: /\.env$/, exclude: /\.env\.example$/, label: '.env file (should be gitignored)' },
    { glob: /google-oauth-token\.json$/, label: 'Google OAuth token file' },
    { glob: /client_secret.*\.json$/, label: 'Google OAuth client secret file' },
    { glob: /service-account.*\.json$/, label: 'Google service account key' },
  ];

  const allFiles = walkDir(PROJECT_ROOT);

  for (const filePath of allFiles) {
    const relativePath = path.relative(PROJECT_ROOT, filePath);
    // Skip files already covered by .gitignore
    if (isGitignored(relativePath)) continue;

    const basename = path.basename(filePath);
    for (const { glob, exclude, label } of sensitiveFilePatterns) {
      if (glob.test(basename) && (!exclude || !exclude.test(basename))) {
        findings.push({
          file: relativePath,
          line: 0,
          level: 'high',
          label,
          context: basename,
        });
      }
    }
  }

  return findings;
}

function isAllowedCredentialFile(relativePath) {
  relativePath = relativePath.replace(/\\/g, '/');
  return ALLOWED_CREDENTIAL_FILES.has(relativePath);
}

// Main
console.log('🔍 Scanning for secrets...\n');

// Load gitignore patterns first
GITIGNORE_PATTERNS = loadGitignorePatterns();

const allFiles = walkDir(PROJECT_ROOT);
console.log(`  Checking ${allFiles.length} files...`);

let allFindings = [];

// Check file contents
for (const filePath of allFiles) {
  const relativePath = path.relative(PROJECT_ROOT, filePath);

  // Skip files covered by .gitignore
  if (isGitignored(relativePath)) continue;

  const findings = checkFileForSecrets(filePath);

  // Filter out allowed credential files from high-confidence findings
  const filteredFindings = findings.filter((f) => {
    if (f.level === 'high' && isAllowedCredentialFile(f.file)) {
      return false;
    }
    return true;
  });

  allFindings = allFindings.concat(filteredFindings);
}

// Check for sensitive files
const sensitiveFileFindings = checkSensitiveFiles();
allFindings = allFindings.concat(sensitiveFileFindings);

// De-duplicate by file+line+label
const seen = new Set();
const unique = allFindings.filter((f) => {
  const key = `${f.file}:${f.line}:${f.label}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

const highFindings = unique.filter((f) => f.level === 'high');
const mediumFindings = unique.filter((f) => f.level === 'medium');

if (highFindings.length > 0) {
  console.log(`\n❌ HIGH-confidence findings (${highFindings.length}):`);
  for (const f of highFindings) {
    console.log(`  ${f.file}:${f.line} — ${f.label}`);
    console.log(`    → ${f.context}`);
  }
}

if (mediumFindings.length > 0) {
  console.log(`\n⚠️  MEDIUM-confidence findings (${mediumFindings.length}):`);
  for (const f of mediumFindings) {
    console.log(`  ${f.file}:${f.line} — ${f.label}`);
    console.log(`    → ${f.context}`);
  }
}

if (unique.length === 0) {
  console.log('\n✅ No secrets found.');
  process.exit(0);
} else {
  console.log(`\n🚨 ${unique.length} potential secret(s) detected.`);
  if (highFindings.length > 0) {
    console.log('   High-confidence findings should be addressed immediately.');
    console.log('   Rotate any exposed secrets and add files to .gitignore.');
  }
  process.exit(1);
}
