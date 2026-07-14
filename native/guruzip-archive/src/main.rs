use std::collections::HashSet;
use std::env;
use std::error::Error;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::thread;

use zip::{CompressionMethod, ZipArchive};

type Result<T> = std::result::Result<T, Box<dyn Error>>;
const FILE_EXTRACTION_CONCURRENCY: usize = 8;
const COPY_BUFFER_BYTES: usize = 1024 * 1024;

#[derive(Debug)]
struct ExtractArgs {
    archive: PathBuf,
    destination: PathBuf,
    manifest_out: PathBuf,
    data_out: PathBuf,
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

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args = parse_args()?;
    let stats = extract_archive(&args)?;
    println!(
        "{{\"files\":{},\"fileBytes\":{},\"manifestBytes\":{},\"dataBytes\":{}}}",
        stats.file_count, stats.file_bytes, stats.manifest_bytes, stats.data_bytes
    );
    Ok(())
}

fn parse_args() -> Result<ExtractArgs> {
    let mut args = env::args_os().skip(1);
    let command = args
        .next()
        .ok_or_else(|| invalid_input("usage: guruzip-archive extract --archive <path> --destination <path> --manifest-out <path> --data-out <path>"))?;
    if command != "extract" {
        return Err(invalid_input("only the 'extract' command is supported").into());
    }

    let mut archive = None;
    let mut destination = None;
    let mut manifest_out = None;
    let mut data_out = None;
    while let Some(flag) = args.next() {
        let value = args.next().ok_or_else(|| {
            invalid_input(format!("missing value for {}", flag.to_string_lossy()))
        })?;
        match flag.to_string_lossy().as_ref() {
            "--archive" => archive = Some(PathBuf::from(value)),
            "--destination" => destination = Some(PathBuf::from(value)),
            "--manifest-out" => manifest_out = Some(PathBuf::from(value)),
            "--data-out" => data_out = Some(PathBuf::from(value)),
            other => return Err(invalid_input(format!("unknown argument: {other}")).into()),
        }
    }

    Ok(ExtractArgs {
        archive: archive.ok_or_else(|| invalid_input("--archive is required"))?,
        destination: destination.ok_or_else(|| invalid_input("--destination is required"))?,
        manifest_out: manifest_out.ok_or_else(|| invalid_input("--manifest-out is required"))?,
        data_out: data_out.ok_or_else(|| invalid_input("--data-out is required"))?,
    })
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
    let mut copy_buffer = vec![0; COPY_BUFFER_BYTES];
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

    let (file_count, file_bytes) = extract_project_files_parallel(
        &args.archive,
        &args.destination,
        plan.files,
        FILE_EXTRACTION_CONCURRENCY,
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
                extract_file_batch(archive_path, destination_root, batch)
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
) -> Result<(usize, u64)> {
    let archive_file = File::open(archive_path)?;
    let mut archive = ZipArchive::new(BufReader::new(archive_file))?;
    let mut count = 0;
    let mut bytes = 0;
    let mut copy_buffer = vec![0; COPY_BUFFER_BYTES];
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
    if relative_path.is_empty() {
        return Err(invalid_input("files/ contains an empty path").into());
    }
    if relative_path.contains('\\') || relative_path.starts_with('/') || relative_path.contains(':')
    {
        return Err(
            invalid_input(format!("files/ contains an unsafe path: {relative_path}")).into(),
        );
    }
    if relative_path
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err(
            invalid_input(format!("files/ contains an unsafe path: {relative_path}")).into(),
        );
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
    use super::validate_relative_path;

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
}
