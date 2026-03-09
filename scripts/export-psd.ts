const fs = require('node:fs/promises') as typeof import('node:fs/promises');
const path = require('node:path') as typeof import('node:path');
const os = require('node:os') as typeof import('node:os');
const readline = require('node:readline/promises') as typeof import('node:readline/promises');
const { spawn } = require('node:child_process') as typeof import('node:child_process');
const { initializeCanvas, readPsd } = require('ag-psd') as typeof import('ag-psd');
const ffmpegStatic = require('ffmpeg-static') as string | null;

type Layer = import('ag-psd').Layer;
type PixelData = import('ag-psd').PixelData;
type Psd = import('ag-psd').Psd;

type OutputFormat = 'png' | 'webp';

interface CliOptions {
  inputPath: string;
  outputDir: string;
  formats: OutputFormat[];
}

interface ExportContext {
  options: CliOptions;
  tempRoot: string;
  textureDir: string;
  canvasWidth: number;
  canvasHeight: number;
  progress: ProgressTracker;
}

interface CharacterLayerEntry {
  id: string;
  group: string;
  name: string;
  order: number;
  path: string;
}

class SimpleImageData {
  width: number;
  height: number;
  data: Uint8ClampedArray;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}

class SimpleContext2D {
  createImageData(width: number, height: number): SimpleImageData {
    return new SimpleImageData(width, height);
  }

  putImageData(): void {
    // No-op. The exporter only reads raw ImageData.
  }
}

class SimpleCanvas {
  width: number;
  height: number;
  private readonly context = new SimpleContext2D();

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  getContext(contextId: string): SimpleContext2D {
    if (contextId !== '2d') {
      throw new Error(`Unsupported canvas context: ${contextId}`);
    }

    return this.context;
  }
}

class ProgressTracker {
  private readonly total: number;
  private readonly startedAt = Date.now();
  private completed = 0;
  private lastLabel = 'Preparing';

  constructor(total: number) {
    this.total = Math.max(total, 1);
    this.render();
  }

  start(label: string): void {
    this.lastLabel = label;
    this.render();
  }

  complete(label: string): void {
    this.completed += 1;
    this.lastLabel = label;
    this.render();
  }

  finish(): void {
    this.render(true);
    if (process.stdout.isTTY) {
      process.stdout.write('\n');
    }
  }

  private render(forceNewline = false): void {
    const percent = Math.min(1, this.completed / this.total);
    const width = 24;
    const filled = Math.round(percent * width);
    const bar = `${'='.repeat(filled)}${'-'.repeat(width - filled)}`;
    const elapsedSec = Math.max((Date.now() - this.startedAt) / 1000, 0.001);
    const speed = this.completed / elapsedSec;
    const line = `[${bar}] ${this.completed}/${this.total} ${(percent * 100).toFixed(1)}% ${speed.toFixed(2)} img/s ${this.lastLabel}`;

    if (process.stdout.isTTY && !forceNewline) {
      process.stdout.write(`\r${line.padEnd(120)}`);
      return;
    }

    process.stdout.write(`${line}\n`);
  }
}

initializeCanvas(
  (width: number, height: number) => new SimpleCanvas(width, height) as unknown as HTMLCanvasElement,
  (width: number, height: number) => new SimpleImageData(width, height) as unknown as ImageData,
);

async function main(): Promise<void> {
  const options = await resolveOptions(process.argv.slice(2));
  const inputPath = path.resolve(options.inputPath);
  const outputDir = path.resolve(options.outputDir);
  const psdBuffer = await fs.readFile(inputPath);
  const psd = readPsd(psdBuffer, {
    useImageData: true,
    skipThumbnail: true,
  }) as Psd;

  if (!psd.imageData) {
    throw new Error('PSD composite image data is missing. Make sure the source PSD contains a composite image.');
  }

  await fs.mkdir(outputDir, { recursive: true });

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'psd2mano-'));
  const textureDir = path.join(outputDir, 'texture');
  await fs.mkdir(textureDir, { recursive: true });
  const progress = new ProgressTracker(countExportTasks(psd, options.formats.length));

  const context: ExportContext = {
    options: { ...options, inputPath, outputDir },
    tempRoot,
    textureDir,
    canvasWidth: psd.width,
    canvasHeight: psd.height,
    progress,
  };

  try {
    await exportComposite(psd, context);
    await exportLayers(psd.children ?? [], textureDir, context);
    await exportModel(psd, context);
    progress.finish();
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function resolveOptions(argv: string[]): Promise<CliOptions> {
  const parsed = parseArgs(argv);
  if (parsed) {
    return parsed;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    printUsageAndExit();
  }

  return promptForOptions();
}

function parseArgs(argv: string[]): CliOptions | null {
  if (argv.length === 0) {
    return null;
  }

  const formats = new Set<OutputFormat>();
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--format' || arg === '-f') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('Missing value after --format');
      }

      addFormats(value, formats);
      index += 1;
      continue;
    }

    if (arg.startsWith('--format=')) {
      addFormats(arg.slice('--format='.length), formats);
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      printUsageAndExit(0);
    }

    positional.push(arg);
  }

  if (positional.length < 2) {
    return null;
  }

  if (positional.length > 2) {
    for (const extra of positional.slice(2)) {
      addFormats(extra, formats);
    }
  }

  if (formats.size === 0) {
    formats.add('png');
    formats.add('webp');
  }

  return {
    inputPath: positional[0],
    outputDir: positional[1],
    formats: [...formats],
  };
}

async function promptForOptions(): Promise<CliOptions> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const psdFiles = await findPsdFiles(process.cwd());
    process.stdout.write('Interactive mode\n');

    if (psdFiles.length > 0) {
      process.stdout.write('Detected PSD files:\n');
      for (const [index, file] of psdFiles.slice(0, 9).entries()) {
        process.stdout.write(`  ${index + 1}. ${file}\n`);
      }
    }

    const firstPsd = psdFiles[0] ?? '';
    const inputAnswer = (await rl.question(`PSD path${firstPsd ? ` [${firstPsd}]` : ''}: `)).trim();
    const inputPath = resolvePsdSelection(inputAnswer, psdFiles) || firstPsd;
    if (!inputPath) {
      throw new Error('PSD path is required.');
    }

    const defaultOutputDir = path.join(
      path.dirname(inputPath),
      `${path.basename(inputPath, path.extname(inputPath))}-export`,
    );
    const outputAnswer = (await rl.question(`Output dir [${defaultOutputDir}]: `)).trim();
    const formatAnswer = (await rl.question('Formats [png,webp]: ')).trim();

    const formats = new Set<OutputFormat>();
    addFormats(formatAnswer || 'png,webp', formats);

    return {
      inputPath,
      outputDir: outputAnswer || defaultOutputDir,
      formats: [...formats],
    };
  } finally {
    rl.close();
  }
}

function resolvePsdSelection(input: string, psdFiles: string[]): string {
  if (!input) {
    return '';
  }

  if (/^\d+$/.test(input)) {
    const index = Number(input) - 1;
    if (index >= 0 && index < psdFiles.length) {
      return psdFiles[index];
    }
  }

  return input;
}

async function findPsdFiles(rootDir: string): Promise<string[]> {
  const results: string[] = [];
  await walkForPsd(rootDir, rootDir, results, 2);
  return results;
}

async function walkForPsd(
  baseDir: string,
  currentDir: string,
  results: string[],
  depthLeft: number,
): Promise<void> {
  if (depthLeft < 0 || results.length >= 9) {
    return;
  }

  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (results.length >= 9) {
      return;
    }

    if (entry.name === 'node_modules' || entry.name.startsWith('.git')) {
      continue;
    }

    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walkForPsd(baseDir, fullPath, results, depthLeft - 1);
      continue;
    }

    if (entry.isFile() && entry.name.toLowerCase().endsWith('.psd')) {
      results.push(path.relative(baseDir, fullPath));
    }
  }
}

function addFormats(value: string, formats: Set<OutputFormat>): void {
  for (const part of value.split(',')) {
    const normalized = part.trim().toLowerCase();
    if (!normalized) {
      continue;
    }

    if (normalized !== 'png' && normalized !== 'webp') {
      throw new Error(`Unsupported format: ${part}`);
    }

    formats.add(normalized);
  }
}

function printUsageAndExit(code = 1): never {
  const usage = [
    'Usage:',
    '  npm run export:psd -- <input.psd> <output-dir> [--format png|webp|png,webp]',
    '',
    'Examples:',
    '  npm run export:psd -- ./demo.psd ./output',
    '  npm run export:psd -- ./demo.psd ./output --format png',
  ].join('\n');

  const writer = code === 0 ? process.stdout : process.stderr;
  writer.write(`${usage}\n`);
  process.exit(code);
}

async function exportComposite(psd: Psd, context: ExportContext): Promise<void> {
  const baseName = getBaseName(context.options.inputPath);
  for (const format of context.options.formats) {
    const outputPath = path.join(context.textureDir, `${baseName}.${format}`);
    const fullCanvasImage = toFullCanvasPixelData(psd.imageData!, 0, 0, context.canvasWidth, context.canvasHeight);
    context.progress.start(path.relative(context.options.outputDir, outputPath));
    await writePixelData(fullCanvasImage, outputPath, format, context.tempRoot);
    context.progress.complete(path.relative(context.options.outputDir, outputPath));
  }
}

async function exportLayers(
  layers: Layer[],
  currentDir: string,
  context: ExportContext,
): Promise<void> {
  const seenNames = new Map<string, number>();

  for (const layer of layers) {
    const safeName = uniquifyName(sanitizeFileName(layer.name?.trim() || 'layer'), seenNames);

    if (layer.children?.length) {
      const groupDir = path.join(currentDir, safeName);
      await fs.mkdir(groupDir, { recursive: true });
      await exportLayers(layer.children, groupDir, context);
      continue;
    }

    if (!layer.imageData) {
      continue;
    }

    const fullCanvasImage = toFullCanvasPixelData(
      layer.imageData,
      layer.left ?? 0,
      layer.top ?? 0,
      context.canvasWidth,
      context.canvasHeight,
    );

    for (const format of context.options.formats) {
      const outputPath = path.join(currentDir, `${safeName}.${format}`);
      context.progress.start(path.relative(context.options.outputDir, outputPath));
      await writePixelData(fullCanvasImage, outputPath, format, context.tempRoot);
      context.progress.complete(path.relative(context.options.outputDir, outputPath));
    }
  }
}

async function exportModel(psd: Psd, context: ExportContext): Promise<void> {
  const modelPath = path.join(context.options.outputDir, 'model.char.json');
  const model = {
    version: '1.0.0',
    metadata: {
      name: getBaseName(context.options.inputPath),
      exportedAt: new Date().toISOString(),
    },
    settings: {
      basePath: './',
    },
    assets: {
      layers: buildModelLayers(psd.children ?? [], getModelFormat(context.options.formats)),
    },
    controller: {
      baseLayers: [],
      defaultPoses: [],
      poses: {},
    },
  };

  await fs.writeFile(modelPath, `${JSON.stringify(model, null, 2)}\n`, 'utf8');
}

async function writePixelData(
  pixelData: PixelData,
  outputPath: string,
  format: OutputFormat,
  tempRoot: string,
): Promise<void> {
  if (!(pixelData.width > 0 && pixelData.height > 0)) {
    return;
  }

  const rgba = normalizeToRgbaBuffer(pixelData);
  const tempInputPath = path.join(tempRoot, `${process.hrtime.bigint()}.rgba`);
  await fs.writeFile(tempInputPath, rgba);

  try {
    await runFfmpeg(tempInputPath, pixelData.width, pixelData.height, outputPath, format);
  } finally {
    await fs.rm(tempInputPath, { force: true });
  }
}

function normalizeToRgbaBuffer(pixelData: PixelData): Buffer {
  const { data, width, height } = pixelData;
  const expectedSize = width * height * 4;

  if (data.length !== expectedSize) {
    throw new Error(`Unexpected pixel data length: expected ${expectedSize}, got ${data.length}`);
  }

  if (data instanceof Uint8Array || data instanceof Uint8ClampedArray) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }

  const rgba = Buffer.allocUnsafe(expectedSize);
  for (let index = 0; index < expectedSize; index += 1) {
    rgba[index] = Math.max(0, Math.min(255, Math.round(Number(data[index]))));
  }
  return rgba;
}

function toFullCanvasPixelData(
  pixelData: PixelData,
  left: number,
  top: number,
  canvasWidth: number,
  canvasHeight: number,
): PixelData {
  const source = normalizeToRgbaBuffer(pixelData);
  const output = new Uint8ClampedArray(canvasWidth * canvasHeight * 4);
  const srcWidth = pixelData.width;
  const srcHeight = pixelData.height;

  for (let y = 0; y < srcHeight; y += 1) {
    const destY = top + y;
    if (destY < 0 || destY >= canvasHeight) {
      continue;
    }

    for (let x = 0; x < srcWidth; x += 1) {
      const destX = left + x;
      if (destX < 0 || destX >= canvasWidth) {
        continue;
      }

      const srcOffset = (y * srcWidth + x) * 4;
      const destOffset = (destY * canvasWidth + destX) * 4;
      output[destOffset + 0] = source[srcOffset + 0];
      output[destOffset + 1] = source[srcOffset + 1];
      output[destOffset + 2] = source[srcOffset + 2];
      output[destOffset + 3] = source[srcOffset + 3];
    }
  }

  return {
    width: canvasWidth,
    height: canvasHeight,
    data: output,
  };
}

function buildModelLayers(layers: Layer[], format: OutputFormat): CharacterLayerEntry[] {
  const entries: CharacterLayerEntry[] = [];
  const orderRef = { value: 1 };
  collectModelLayers(layers, '', format, entries, orderRef);
  return entries;
}

function collectModelLayers(
  layers: Layer[],
  parentGroup: string,
  format: OutputFormat,
  entries: CharacterLayerEntry[],
  orderRef: { value: number },
): void {
  const seenNames = new Map<string, number>();

  for (const layer of layers) {
    const safeName = uniquifyName(sanitizeFileName(layer.name?.trim() || 'layer'), seenNames);
    const id = parentGroup ? `${parentGroup}/${safeName}` : safeName;

    if (layer.children?.length) {
      collectModelLayers(layer.children, id, format, entries, orderRef);
      continue;
    }

    if (!layer.imageData) {
      continue;
    }

    entries.push({
      id,
      group: parentGroup,
      name: safeName,
      order: orderRef.value,
      path: normalizeModelPath(path.join('texture', `${id}.${format}`)),
    });
    orderRef.value += 1;
  }
}

function getModelFormat(formats: OutputFormat[]): OutputFormat {
  return formats.includes('png') ? 'png' : formats[0];
}

function normalizeModelPath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function countExportTasks(psd: Psd, formatCount: number): number {
  return formatCount + countLeafLayers(psd.children ?? []) * formatCount;
}

function countLeafLayers(layers: Layer[]): number {
  let count = 0;

  for (const layer of layers) {
    if (layer.children?.length) {
      count += countLeafLayers(layer.children);
      continue;
    }

    if (layer.imageData) {
      count += 1;
    }
  }

  return count;
}

async function runFfmpeg(
  inputPath: string,
  width: number,
  height: number,
  outputPath: string,
  format: OutputFormat,
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'rawvideo',
    '-pixel_format',
    'rgba',
    '-video_size',
    `${width}x${height}`,
    '-i',
    inputPath,
    '-frames:v',
    '1',
  ];

  if (format === 'png') {
    args.push('-c:v', 'png');
  } else {
    args.push('-c:v', 'libwebp', '-lossless', '1', '-compression_level', '6', '-q:v', '100');
  }

  args.push(outputPath);

  const candidates = getFfmpegCandidates();
  let lastError: Error | null = null;

  for (const candidate of candidates) {
    try {
      await runFfmpegOnce(candidate, args, outputPath);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error(`Unable to run ffmpeg for ${outputPath}`);
}

function getFfmpegCandidates(): string[] {
  const candidates = [
    process.env.FFMPEG_PATH,
    ffmpegStatic,
    'ffmpeg',
  ].filter((value): value is string => Boolean(value));

  return [...new Set(candidates)];
}

async function runFfmpegOnce(command: string, args: string[], outputPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(new Error(`Failed to start ffmpeg command "${command}": ${error.code ?? error.message}`));
    });

    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `ffmpeg command "${command}" exited with code ${code ?? 'unknown'} while writing ${outputPath}\n${stderr}`.trim(),
        ),
      );
    });
  });
}

function getBaseName(filePath: string): string {
  return sanitizeFileName(path.basename(filePath, path.extname(filePath)));
}

function sanitizeFileName(name: string): string {
  const sanitized = name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').replace(/[. ]+$/g, '').trim();
  return sanitized || 'unnamed';
}

function uniquifyName(name: string, seenNames: Map<string, number>): string {
  const current = seenNames.get(name) ?? 0;
  seenNames.set(name, current + 1);
  return current === 0 ? name : `${name}_${current + 1}`;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
