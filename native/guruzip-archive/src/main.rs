use std::collections::HashSet;
use std::env;
use std::error::Error;
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, BufWriter, Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::thread;

use serde::Deserialize;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

type Result<T> = std::result::Result<T, Box<dyn Error>>;
const FILE_EXTRACTION_CONCURRENCY: usize = 8;
const DEFAULT_COPY_BUFFER_BYTES: usize = 10 * 1024 * 1024;
const MIN_COPY_BUFFER_BYTES: usize = 64 * 1024;
const MAX_COPY_BUFFER_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug)]
enum CommandArgs {
    Extract(ExtractArgs),
    Create(CreateArgs),
    Pack(PackArgs),
}

#[derive(Debug)]
struct ExtractArgs {
    archive: PathBuf,
    destination: PathBuf,
    manifest_out: PathBuf,
    data_out: PathBuf,
    copy_buffer_bytes: usize,
}

#[derive(Debug)]
struct CreateArgs {
    archive: PathBuf,
    source: PathBuf,
    manifest: PathBuf,
    data: PathBuf,
    copy_buffer_bytes: usize,
}

#[derive(Debug)]
struct PackArgs {
    archive: PathBuf,
    entries: PathBuf,
    copy_buffer_bytes: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackEntry {
    source: PathBuf,
    archive_path: String,
    compression: PackCompression,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum PackCompression {
    Store,
    Deflate,
}

#[derive(Debug)]
struct SourceFile {
    absolute_path: PathBuf,
    archive_path: String,
}

#[derive(Debug)]
struct FilePlan {
    index: usize,
    relative_path: PathBuf,
}

#[derive(Debug)]
struct ArchivePlan {
    manifest_index: usize,
    data_index: usize,
    files: Vec<FilePlan>,
}

#[derive(Default)]
struct ExtractStats {
    file_count: usize,
    file_bytes: u64,
    manifest_bytes: u64,
    data_bytes: u64,
}

#[derive(Default)]
struct CreateStats {
    file_count: usize,
    file_bytes: u64,
    archive_bytes: u64,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    match parse_args()? {
        CommandArgs::Extract(args) => {
            let stats = extract_archive(&args)?;
            println!(
                "{{\"files\":{},\"fileBytes\":{},\"manifestBytes\":{},\"dataBytes\":{},\"bufferBytes\":{}}}",
                stats.file_count,
                stats.file_bytes,
                stats.manifest_bytes,
                stats.data_bytes,
                args.copy_buffer_bytes
            );
        }
        CommandArgs::Create(args) => {
            let stats = create_archive(&args)?;
            println!(
                "{{\"files\":{},\"fileBytes\":{},\"archiveBytes\":{},\"bufferBytes\":{}}}",
                stats.file_count, stats.file_bytes, stats.archive_bytes, args.copy_buffer_bytes
            );
        }
        CommandArgs::Pack(args) => {
            let stats = pack_archive(&args)?;
            println!(
                "{{\"files\":{},\"fileBytes\":{},\"archiveBytes\":{},\"bufferBytes\":{}}}",
                stats.file_count, stats.file_bytes, stats.archive_bytes, args.copy_buffer_bytes
            );
        }
    }
    Ok(())
}

fn parse_args() -> Result<CommandArgs> {
    let mut args = env::args_os().skip(1);
    let command = args
        .next()
        .ok_or_else(|| invalid_input("usage: guruzip-archive <extract|create|pack> [options]"))?;
    match command.to_string_lossy().as_ref() {
        "extract" => Ok(CommandArgs::Extract(parse_extract_args(args)?)),
        "create" => Ok(CommandArgs::Create(parse_create_args(args)?)),
        "pack" => Ok(CommandArgs::Pack(parse_pack_args(args)?)),
        other => Err(invalid_input(format!("unsupported command: {other}")).into()),
    }
}

fn parse_pack_args(args: impl Iterator<Item = OsString>) -> Result<PackArgs> {
    let mut archive = None;
    let mut entries = None;
    let mut copy_buffer_bytes = DEFAULT_COPY_BUFFER_BYTES;
    let mut args = args.peekable();
    while let Some(flag) = args.next() {
        let value = args.next().ok_or_else(|| {
            invalid_input(format!("missing value for {}", flag.to_string_lossy()))
        })?;
        match flag.to_string_lossy().as_ref() {
            "--archive" => archive = Some(PathBuf::from(value)),
            "--entries" => entries = Some(PathBuf::from(value)),
            "--buffer-bytes" => copy_buffer_bytes = parse_copy_buffer_bytes(&value)?,
            other => return Err(invalid_input(format!("unknown argument: {other}")).into()),
        }
    }

    Ok(PackArgs {
        archive: archive.ok_or_else(|| invalid_input("--archive is required"))?,
        entries: entries.ok_or_else(|| invalid_input("--entries is required"))?,
        copy_buffer_bytes,
    })
}

fn parse_extract_args(args: impl Iterator<Item = OsString>) -> Result<ExtractArgs> {
    let mut archive = None;
    let mut destination = None;
    let mut manifest_out = None;
    let mut data_out = None;
    let mut copy_buffer_bytes = DEFAULT_COPY_BUFFER_BYTES;
    let mut args = args.peekable();
    while let Some(flag) = args.next() {
        let value = args.next().ok_or_else(|| {
            invalid_input(format!("missing value for {}", flag.to_string_lossy()))
        })?;
        match flag.to_string_lossy().as_ref() {
            "--archive" => archive = Some(PathBuf::from(value)),
            "--destination" => destination = Some(PathBuf::from(value)),
            "--manifest-out" => manifest_out = Some(PathBuf::from(value)),
            "--data-out" => data_out = Some(PathBuf::from(value)),
            "--buffer-bytes" => copy_buffer_bytes = parse_copy_buffer_bytes(&value)?,
            other => return Err(invalid_input(format!("unknown argument: {other}")).into()),
        }
    }

    Ok(ExtractArgs {
        archive: archive.ok_or_else(|| invalid_input("--archive is required"))?,
        destination: destination.ok_or_else(|| invalid_input("--destination is required"))?,
        manifest_out: manifest_out.ok_or_else(|| invalid_input("--manifest-out is required"))?,
        data_out: data_out.ok_or_else(|| invalid_input("--data-out is required"))?,
        copy_buffer_bytes,
    })
}

fn parse_create_args(args: impl Iterator<Item = OsString>) -> Result<CreateArgs> {
    let mut archive = None;
    let mut source = None;
    let mut manifest = None;
    let mut data = None;
    let mut copy_buffer_bytes = DEFAULT_COPY_BUFFER_BYTES;
    let mut args = args.peekable();
    while let Some(flag) = args.next() {
        let value = args.next().ok_or_else(|| {
            invalid_input(format!("missing value for {}", flag.to_string_lossy()))
        })?;
        match flag.to_string_lossy().as_ref() {
            "--archive" => archive = Some(PathBuf::from(value)),
            "--source" => source = Some(PathBuf::from(value)),
            "--manifest" => manifest = Some(PathBuf::from(value)),
            "--data" => data = Some(PathBuf::from(value)),
            "--buffer-bytes" => copy_buffer_bytes = parse_copy_buffer_bytes(&value)?,
            other => return Err(invalid_input(format!("unknown argument: {other}")).into()),
        }
    }

    Ok(CreateArgs {
        archive: archive.ok_or_else(|| invalid_input("--archive is required"))?,
        source: source.ok_or_else(|| invalid_input("--source is required"))?,
        manifest: manifest.ok_or_else(|| invalid_input("--manifest is required"))?,
        data: data.ok_or_else(|| invalid_input("--data is required"))?,
        copy_buffer_bytes,
    })
}

fn parse_copy_buffer_bytes(value: &OsString) -> Result<usize> {
    let parsed = value
        .to_str()
        .ok_or_else(|| invalid_input("--buffer-bytes must be UTF-8"))?
        .parse::<usize>()
        .map_err(|_| invalid_input("--buffer-bytes must be an integer"))?;
    if !(MIN_COPY_BUFFER_BYTES..=MAX_COPY_BUFFER_BYTES).contains(&parsed) {
        return Err(invalid_input(format!(
            "--buffer-bytes must be between {MIN_COPY_BUFFER_BYTES} and {MAX_COPY_BUFFER_BYTES}"
        ))
        .into());
    }
    Ok(parsed)
}

fn create_archive(args: &CreateArgs) -> Result<CreateStats> {
    if !args.source.is_dir() {
        return Err(invalid_input(format!(
            "project source directory does not exist: {}",
            args.source.display()
        ))
        .into());
    }
    if !args.manifest.is_file() || !args.data.is_file() {
        return Err(invalid_input("manifest and data inputs must be files").into());
    }

    let source_files = collect_source_files(&args.source)?;
    ensure_parent(&args.archive)?;
    let archive_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&args.archive)?;
    let mut writer = ZipWriter::new(BufWriter::new(archive_file));
    let mut copy_buffer = vec![0; args.copy_buffer_bytes];

    write_zip_entry(
        &mut writer,
        "manifest.json",
        &args.manifest,
        CompressionMethod::Deflated,
        &mut copy_buffer,
    )?;
    write_zip_entry(
        &mut writer,
        "data.json",
        &args.data,
        CompressionMethod::Deflated,
        &mut copy_buffer,
    )?;

    let mut stats = CreateStats::default();
    for source_file in source_files {
        let compression = project_file_compression(&source_file.archive_path);
        let archive_path = format!("files/{}", source_file.archive_path);
        stats.file_bytes += write_zip_entry(
            &mut writer,
            &archive_path,
            &source_file.absolute_path,
            compression,
            &mut copy_buffer,
        )?;
        stats.file_count += 1;
    }

    let mut output = writer.finish()?;
    output.flush()?;
    drop(output);
    stats.archive_bytes = fs::metadata(&args.archive)?.len();
    Ok(stats)
}

fn pack_archive(args: &PackArgs) -> Result<CreateStats> {
    if !args.entries.is_file() {
        return Err(invalid_input(format!(
            "entry manifest does not exist: {}",
            args.entries.display()
        ))
        .into());
    }
    let entries: Vec<PackEntry> =
        serde_json::from_reader(BufReader::new(File::open(&args.entries)?))?;
    let mut archive_paths = HashSet::with_capacity(entries.len());
    for entry in &entries {
        validate_archive_path(&entry.archive_path)?;
        if !archive_paths.insert(entry.archive_path.as_str()) {
            return Err(invalid_input(format!(
                "entry manifest contains a duplicate archive path: {}",
                entry.archive_path
            ))
            .into());
        }
        if !entry.source.is_file() {
            return Err(invalid_input(format!(
                "entry source is not a regular file: {}",
                entry.source.display()
            ))
            .into());
        }
    }

    ensure_parent(&args.archive)?;
    let archive_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&args.archive)?;
    let mut writer = ZipWriter::new(BufWriter::new(archive_file));
    let mut copy_buffer = vec![0; args.copy_buffer_bytes];
    let mut stats = CreateStats::default();
    for entry in entries {
        let compression = match entry.compression {
            PackCompression::Store => CompressionMethod::Stored,
            PackCompression::Deflate => CompressionMethod::Deflated,
        };
        stats.file_bytes += write_zip_entry(
            &mut writer,
            &entry.archive_path,
            &entry.source,
            compression,
            &mut copy_buffer,
        )?;
        stats.file_count += 1;
    }
    let mut output = writer.finish()?;
    output.flush()?;
    drop(output);
    stats.archive_bytes = fs::metadata(&args.archive)?.len();
    Ok(stats)
}

fn collect_source_files(source_root: &Path) -> Result<Vec<SourceFile>> {
    let mut files = Vec::new();
    collect_source_files_recursive(source_root, source_root, &mut files)?;
    files.sort_by(|left, right| left.archive_path.cmp(&right.archive_path));
    Ok(files)
}

fn collect_source_files_recursive(
    source_root: &Path,
    directory: &Path,
    files: &mut Vec<SourceFile>,
) -> Result<()> {
    let mut entries = fs::read_dir(directory)?.collect::<std::result::Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let file_type = entry.file_type()?;
        let absolute_path = entry.path();
        if file_type.is_dir() {
            collect_source_files_recursive(source_root, &absolute_path, files)?;
        } else if file_type.is_file() {
            let relative = absolute_path.strip_prefix(source_root)?;
            let archive_path = relative
                .iter()
                .map(|segment| {
                    segment.to_str().ok_or_else(|| {
                        invalid_input(format!(
                            "project file path is not valid UTF-8: {}",
                            absolute_path.display()
                        ))
                    })
                })
                .collect::<std::result::Result<Vec<_>, _>>()?
                .join("/");
            validate_relative_path(&archive_path)?;
            files.push(SourceFile {
                absolute_path,
                archive_path,
            });
        }
        // Symlinks and other special filesystem entries are intentionally omitted, matching the
        // TypeScript exporter that only includes ordinary files and directories.
    }
    Ok(())
}

fn project_file_compression(archive_path: &str) -> CompressionMethod {
    let extension = Path::new(archive_path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(
        extension.as_str(),
        "css"
            | "csv"
            | "fountain"
            | "htm"
            | "html"
            | "ini"
            | "js"
            | "json"
            | "log"
            | "md"
            | "mjs"
            | "svg"
            | "toml"
            | "ts"
            | "txt"
            | "xml"
            | "yaml"
            | "yml"
    ) {
        CompressionMethod::Deflated
    } else {
        CompressionMethod::Stored
    }
}

fn write_zip_entry<W: Write + Seek>(
    writer: &mut ZipWriter<W>,
    archive_path: &str,
    source_path: &Path,
    compression: CompressionMethod,
    copy_buffer: &mut [u8],
) -> Result<u64> {
    let source_bytes = fs::metadata(source_path)?.len();
    let mut options = SimpleFileOptions::default()
        .compression_method(compression)
        .large_file(source_bytes >= u32::MAX as u64)
        .unix_permissions(0o644);
    if compression == CompressionMethod::Deflated {
        options = options.compression_level(Some(6));
    }
    writer.start_file(archive_path, options)?;

    let mut source = BufReader::new(File::open(source_path)?);
    let mut copied = 0;
    loop {
        let read = source.read(copy_buffer)?;
        if read == 0 {
            break;
        }
        writer.write_all(&copy_buffer[..read])?;
        copied += read as u64;
    }
    Ok(copied)
}

fn extract_archive(args: &ExtractArgs) -> Result<ExtractStats> {
    let archive_file = File::open(&args.archive)?;
    let mut archive = ZipArchive::new(BufReader::new(archive_file))?;
    if archive.has_overlapping_files()? {
        return Err(invalid_input("ZIP contains overlapping entries").into());
    }
    let plan = inspect_archive(&mut archive)?;

    fs::create_dir_all(&args.destination)?;
    ensure_parent(&args.manifest_out)?;
    ensure_parent(&args.data_out)?;

    let mut stats = ExtractStats::default();
    let mut copy_buffer = vec![0; args.copy_buffer_bytes];
    stats.manifest_bytes = extract_entry(
        &mut archive,
        plan.manifest_index,
        &args.manifest_out,
        &mut copy_buffer,
    )?;
    stats.data_bytes = extract_entry(
        &mut archive,
        plan.data_index,
        &args.data_out,
        &mut copy_buffer,
    )?;
    drop(copy_buffer);

    let (file_count, file_bytes) = extract_project_files_parallel(
        &args.archive,
        &args.destination,
        plan.files,
        FILE_EXTRACTION_CONCURRENCY,
        args.copy_buffer_bytes,
    )?;
    stats.file_count = file_count;
    stats.file_bytes = file_bytes;

    Ok(stats)
}

fn extract_project_files_parallel(
    archive_path: &Path,
    destination_root: &Path,
    files: Vec<FilePlan>,
    concurrency: usize,
    copy_buffer_bytes: usize,
) -> Result<(usize, u64)> {
    if files.is_empty() {
        return Ok((0, 0));
    }
    let worker_count = concurrency.max(1).min(files.len());
    let batch_size = files.len().div_ceil(worker_count);
    let mut batches = Vec::with_capacity(worker_count);
    let mut remaining = files;
    while !remaining.is_empty() {
        let tail = remaining.split_off(remaining.len().min(batch_size));
        batches.push(remaining);
        remaining = tail;
    }

    let worker_results = thread::scope(|scope| {
        let mut workers = Vec::with_capacity(batches.len());
        for batch in batches {
            workers.push(scope.spawn(move || {
                extract_file_batch(archive_path, destination_root, batch, copy_buffer_bytes)
                    .map_err(|error| error.to_string())
            }));
        }
        workers
            .into_iter()
            .map(|worker| {
                worker
                    .join()
                    .map_err(|_| "guruzip extraction worker panicked".to_owned())?
            })
            .collect::<std::result::Result<Vec<_>, String>>()
    })
    .map_err(invalid_input)?;

    Ok(worker_results
        .into_iter()
        .fold((0, 0), |(count, bytes), result| {
            (count + result.0, bytes + result.1)
        }))
}

fn extract_file_batch(
    archive_path: &Path,
    destination_root: &Path,
    files: Vec<FilePlan>,
    copy_buffer_bytes: usize,
) -> Result<(usize, u64)> {
    let archive_file = File::open(archive_path)?;
    let mut archive = ZipArchive::new(BufReader::new(archive_file))?;
    let mut count = 0;
    let mut bytes = 0;
    let mut copy_buffer = vec![0; copy_buffer_bytes];
    for file_plan in files {
        let destination = destination_root.join(&file_plan.relative_path);
        ensure_parent(&destination)?;
        bytes += extract_entry(
            &mut archive,
            file_plan.index,
            &destination,
            &mut copy_buffer,
        )?;
        count += 1;
    }
    Ok((count, bytes))
}

fn inspect_archive<R: io::Read + io::Seek>(archive: &mut ZipArchive<R>) -> Result<ArchivePlan> {
    let mut manifest_index = None;
    let mut data_index = None;
    let mut files = Vec::new();
    let mut relative_paths = HashSet::new();

    for index in 0..archive.len() {
        let entry = archive.by_index_raw(index)?;
        let name = entry.name();
        validate_supported_entry(&entry, name)?;

        match name {
            "manifest.json" if !entry.is_dir() => {
                if manifest_index.replace(index).is_some() {
                    return Err(
                        invalid_input("ZIP contains duplicate manifest.json entries").into(),
                    );
                }
            }
            "data.json" if !entry.is_dir() => {
                if data_index.replace(index).is_some() {
                    return Err(invalid_input("ZIP contains duplicate data.json entries").into());
                }
            }
            _ if name.starts_with("files/") => {
                let relative = &name["files/".len()..];
                if entry.is_dir() {
                    if !relative.is_empty() {
                        validate_relative_path(relative.trim_end_matches('/'))?;
                    }
                    continue;
                }
                validate_relative_path(relative)?;
                if !relative_paths.insert(relative.to_owned()) {
                    return Err(invalid_input(format!(
                        "ZIP contains duplicate project file: {relative}"
                    ))
                    .into());
                }
                files.push(FilePlan {
                    index,
                    relative_path: relative.split('/').collect(),
                });
            }
            _ => {}
        }
    }

    Ok(ArchivePlan {
        manifest_index: manifest_index
            .ok_or_else(|| invalid_input("ZIP does not contain manifest.json"))?,
        data_index: data_index.ok_or_else(|| invalid_input("ZIP does not contain data.json"))?,
        files,
    })
}

fn validate_supported_entry<R: io::Read>(
    entry: &zip::read::ZipFile<'_, R>,
    name: &str,
) -> Result<()> {
    if name.contains('\0') {
        return Err(invalid_input("ZIP entry contains a NUL byte").into());
    }
    if entry.enclosed_name().is_none() {
        return Err(invalid_input(format!("ZIP entry path is unsafe: {name}")).into());
    }
    if let Some(mode) = entry.unix_mode()
        && mode & 0o170000 == 0o120000
    {
        return Err(invalid_input(format!("ZIP symbolic links are not supported: {name}")).into());
    }
    if !entry.is_dir()
        && entry.compression() != CompressionMethod::Stored
        && entry.compression() != CompressionMethod::Deflated
    {
        return Err(invalid_input(format!(
            "unsupported ZIP compression method for {name}: {:?}",
            entry.compression()
        ))
        .into());
    }
    Ok(())
}

fn validate_relative_path(relative_path: &str) -> Result<()> {
    validate_archive_path(relative_path).map_err(|_| {
        invalid_input(format!("files/ contains an unsafe path: {relative_path}")).into()
    })
}

fn validate_archive_path(archive_path: &str) -> Result<()> {
    if archive_path.is_empty()
        || archive_path.contains('\0')
        || archive_path.contains('\\')
        || archive_path.starts_with('/')
        || archive_path.contains(':')
        || archive_path
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err(invalid_input(format!("unsafe ZIP entry path: {archive_path}")).into());
    }
    Ok(())
}

fn extract_entry<R: io::Read + io::Seek>(
    archive: &mut ZipArchive<R>,
    index: usize,
    destination: &Path,
    copy_buffer: &mut [u8],
) -> Result<u64> {
    let mut entry = archive.by_index(index)?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    let mut copied = 0;
    loop {
        let read = entry.read(copy_buffer)?;
        if read == 0 {
            break;
        }
        output.write_all(&copy_buffer[..read])?;
        copied += read as u64;
    }
    output.flush()?;
    Ok(copied)
}

fn ensure_parent(path: &Path) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| invalid_input(format!("path has no parent: {}", path.display())))?;
    fs::create_dir_all(parent)?;
    Ok(())
}

fn invalid_input(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

#[cfg(test)]
mod tests {
    use super::{project_file_compression, validate_archive_path, validate_relative_path};
    use zip::CompressionMethod;

    #[test]
    fn accepts_normal_project_paths() {
        validate_relative_path("assets/original/image.png").unwrap();
        validate_relative_path("日本語/画像.png").unwrap();
    }

    #[test]
    fn rejects_unsafe_project_paths() {
        for path in [
            "",
            "../evil",
            "a/../../evil",
            "/rooted",
            "C:/evil",
            "a\\evil",
            "a//evil",
            "a/./evil",
            "a:stream",
        ] {
            assert!(
                validate_relative_path(path).is_err(),
                "{path} should be rejected"
            );
        }
    }

    #[test]
    fn validates_generic_archive_paths() {
        for path in ["mimetype", "ppt/media/image1.png", "日本語/画像.png"] {
            validate_archive_path(path).unwrap();
        }
        for path in ["", "../evil", "/rooted", "C:/evil", "a\\evil", "a//evil"] {
            assert!(
                validate_archive_path(path).is_err(),
                "{path} should be rejected"
            );
        }
    }

    #[test]
    fn stores_precompressed_assets_and_deflates_text() {
        assert_eq!(
            project_file_compression("assets/original/image.png"),
            CompressionMethod::Stored
        );
        assert_eq!(
            project_file_compression("notes/README.MD"),
            CompressionMethod::Deflated
        );
    }
}
