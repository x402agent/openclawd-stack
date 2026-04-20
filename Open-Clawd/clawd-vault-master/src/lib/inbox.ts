import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import matter from 'gray-matter';
import { globSync } from 'glob';

export interface InboxItem {
  id: string;
  hash: string;
  title: string;
  content: string;
  path: string;
  relativePath: string;
  capturedAt: Date;
  frontmatter: Record<string, unknown>;
}

export interface ReadInboxItemsOptions {
  includeArchived?: boolean;
  limit?: number;
}

export interface AddInboxItemOptions {
  title?: string;
  source?: string;
  now?: () => Date;
}

export interface AddInboxItemResult {
  id: string;
  hash: string;
  title: string;
  path: string;
  relativePath: string;
  source: string;
}

function normalizeContentForHash(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

function hashContent(content: string): string {
  return createHash('sha256').update(normalizeContentForHash(content)).digest('hex');
}

function ensureInboxDir(vaultPath: string): string {
  const inboxPath = path.join(path.resolve(vaultPath), 'inbox');
  fs.mkdirSync(inboxPath, { recursive: true });
  return inboxPath;
}

function toSlug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .trim();
  return normalized || 'capture';
}

function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', 't');
}

function deriveTitle(content: string): string {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) {
    return 'Inbox Capture';
  }
  return firstLine.slice(0, 80);
}

export function addInboxItem(
  vaultPath: string,
  rawContent: string,
  options: AddInboxItemOptions = {}
): AddInboxItemResult {
  const content = rawContent.replace(/\r\n/g, '\n').trim();
  if (!content) {
    throw new Error('Inbox content is empty.');
  }

  const now = options.now ? options.now() : new Date();
  const source = options.source?.trim() || 'manual';
  const title = options.title?.trim() || deriveTitle(content);
  const hash = hashContent(content);
  const baseSlug = toSlug(title);
  const timestamp = compactTimestamp(now);

  const inboxDir = ensureInboxDir(vaultPath);
  let fileName = `${baseSlug}-${timestamp}-${hash.slice(0, 8)}.md`;
  let fullPath = path.join(inboxDir, fileName);
  let counter = 1;
  while (fs.existsSync(fullPath)) {
    fileName = `${baseSlug}-${timestamp}-${hash.slice(0, 8)}-${counter}.md`;
    fullPath = path.join(inboxDir, fileName);
    counter += 1;
  }

  const doc = matter.stringify(`${content}\n`, {
    title,
    date: now.toISOString().split('T')[0],
    capturedAt: now.toISOString(),
    source,
    type: 'inbox',
    status: 'pending',
    hash
  });
  fs.writeFileSync(fullPath, doc, 'utf-8');

  return {
    id: `inbox/${fileName.replace(/\.md$/, '')}`,
    hash,
    title,
    path: fullPath,
    relativePath: path.join('inbox', fileName),
    source
  };
}

function parseInboxFile(vaultPath: string, fullPath: string): InboxItem {
  const stats = fs.statSync(fullPath);
  const relativePath = path.relative(path.resolve(vaultPath), fullPath);
  const ext = path.extname(fullPath).toLowerCase();
  const raw = fs.readFileSync(fullPath, 'utf-8');

  if (ext === '.md') {
    const parsed = matter(raw);
    const title = typeof parsed.data.title === 'string'
      ? parsed.data.title
      : path.basename(fullPath, ext);
    const capturedAt = typeof parsed.data.capturedAt === 'string'
      ? new Date(parsed.data.capturedAt)
      : stats.mtime;
    const content = parsed.content.trim();
    return {
      id: relativePath.replace(/\\/g, '/').replace(/\.md$/, ''),
      hash: hashContent(content),
      title,
      content,
      path: fullPath,
      relativePath: relativePath.replace(/\\/g, '/'),
      capturedAt,
      frontmatter: parsed.data as Record<string, unknown>
    };
  }

  const content = raw.trim();
  return {
    id: relativePath.replace(/\\/g, '/'),
    hash: hashContent(content),
    title: path.basename(fullPath),
    content,
    path: fullPath,
    relativePath: relativePath.replace(/\\/g, '/'),
    capturedAt: stats.mtime,
    frontmatter: {}
  };
}

export function readInboxItems(vaultPath: string, options: ReadInboxItemsOptions = {}): InboxItem[] {
  const inboxDir = path.join(path.resolve(vaultPath), 'inbox');
  if (!fs.existsSync(inboxDir)) {
    return [];
  }

  const ignore = ['**/processed/**', '**/merged/**'];
  if (!options.includeArchived) {
    ignore.push('**/archive/**');
  }

  const files = globSync('**/*', {
    cwd: inboxDir,
    nodir: true,
    absolute: true,
    ignore
  });

  const items = files
    .map((filePath) => parseInboxFile(vaultPath, filePath))
    .sort((left, right) => left.capturedAt.getTime() - right.capturedAt.getTime());

  if (options.limit && options.limit > 0) {
    return items.slice(0, options.limit);
  }
  return items;
}
