// M3 agent 只读工具：前台窗口 / 系统概要 / 最近文档。
// 全部同步、快速（Win32 + 注册表 + 目录顶层扫描），由 ai::run_tool 直接调用，
// 不是 tauri 命令。失败返回 Err → 步骤行显示 ✗，不炸会话。

use std::path::PathBuf;
use std::time::{Duration, SystemTime};

/// 截到第一个 NUL（Win32 宽字符缓冲在 NUL 后可能有残留字节）。
fn wide_to_string(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

fn human_size(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    if bytes < KB {
        format!("{bytes}B")
    } else if bytes < MB {
        format!("{}KB", bytes / KB)
    } else if bytes % MB == 0 {
        format!("{}MB", bytes / MB)
    } else {
        format!("{:.1}MB", bytes as f64 / MB as f64)
    }
}

fn relative_cn(then: SystemTime, now: SystemTime) -> String {
    let Ok(d) = now.duration_since(then) else {
        // mtime 在未来（时钟漂移）→ 当刚改
        return "刚刚".to_string();
    };
    let s = d.as_secs();
    if s < 60 {
        "刚刚".to_string()
    } else if s < 3600 {
        format!("{}分钟前", s / 60)
    } else if s < 86400 {
        format!("{}小时前", s / 3600)
    } else {
        format!("{}天前", s / 86400)
    }
}

// ============ 注册表（只读）============

/// 读 HKLM\<sub_key> 下某个值名的原始字节（REG_SZ / REG_DWORD 都原样返回）。
fn reg_read_value(sub_key: &str, value: &str) -> Option<Vec<u8>> {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        HKEY, HKEY_LOCAL_MACHINE, KEY_READ, RegCloseKey, RegOpenKeyExW, RegQueryValueExW,
    };

    let key_path = HSTRING::from(sub_key);
    let value_name = HSTRING::from(value);
    unsafe {
        let mut hkey: HKEY = std::mem::zeroed();
        if RegOpenKeyExW(HKEY_LOCAL_MACHINE, &key_path, None, KEY_READ, &mut hkey)
            != ERROR_SUCCESS
        {
            return None;
        }
        let mut size: u32 = 0;
        let mut result: Option<Vec<u8>> = None;
        if RegQueryValueExW(hkey, &value_name, None, None, None, Some(&mut size))
            == ERROR_SUCCESS
        {
            if size == 0 {
                result = Some(Vec::new());
            } else {
                let mut buf = vec![0u8; size as usize];
                let r = RegQueryValueExW(
                    hkey,
                    &value_name,
                    None,
                    None,
                    Some(buf.as_mut_ptr()),
                    Some(&mut size),
                );
                if r == ERROR_SUCCESS {
                    buf.truncate(size as usize);
                    result = Some(buf);
                }
            }
        }
        let _ = RegCloseKey(hkey);
        result
    }
}

fn reg_read_string(sub_key: &str, value: &str) -> Option<String> {
    let raw = reg_read_value(sub_key, value)?;
    if raw.len() < 2 {
        return None;
    }
    let u16s: Vec<u16> = raw
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    let s = wide_to_string(&u16s).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn reg_read_dword(sub_key: &str, value: &str) -> Option<u32> {
    let raw = reg_read_value(sub_key, value)?;
    if raw.len() == 4 {
        Some(u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]))
    } else {
        None
    }
}

// ============ 前台窗口 ============

/// 给定 pid → 进程文件名（PROCESS_QUERY_LIMITED_INFORMATION，只读）。
fn process_name_for_pid(pid: u32) -> Option<String> {
    use winapi::um::handleapi::CloseHandle;
    use winapi::um::processthreadsapi::OpenProcess;
    use winapi::um::winbase::QueryFullProcessImageNameW;
    use winapi::um::winnt::PROCESS_QUERY_LIMITED_INFORMATION;

    if pid == 0 {
        return None;
    }
    // winapi 0.3 所有 extern 函数统一标 unsafe，这些调用本身是安全的。
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION as u32, 0, pid);
        if h.is_null() {
            return None;
        }
        let mut buf = vec![0u16; 1024];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut size);
        let _ = CloseHandle(h);
        if ok == 0 || size == 0 || size as usize > buf.len() {
            return None;
        }
        let path = wide_to_string(&buf[..size as usize]);
        path.rsplit('\\')
            .next()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .or_else(|| Some(path))
    }
}

/// Agent 工具：前台窗口的标题 + 进程名 + PID。
pub fn foreground_window() -> Result<String, String> {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW};

    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return Ok("当前在桌面（没有前台窗口）。".to_string());
    }
    let mut buf = vec![0u16; 512];
    let n = unsafe { GetWindowTextW(hwnd, &mut buf) };
    let title = if n > 0 {
        wide_to_string(&buf[..(n as usize).min(buf.len())])
    } else {
        String::new()
    };
    let mut pid: u32 = 0;
    unsafe {
        winapi::um::winuser::GetWindowThreadProcessId(
            hwnd.0 as *mut winapi::shared::windef::HWND__,
            &mut pid,
        );
    }
    let proc = process_name_for_pid(pid);
    let out = match (title.is_empty(), proc) {
        (false, Some(p)) => format!("窗口标题：\"{title}\"（进程 {p}，PID {pid}）"),
        (false, None) if pid > 0 => format!("窗口标题：\"{title}\"（PID {pid}）"),
        (false, None) => format!("窗口标题：\"{title}\""),
        (true, Some(p)) => format!("前台窗口无标题（进程 {p}，PID {pid}）"),
        (true, None) => "前台窗口无标题，且未取到进程信息。".to_string(),
    };
    Ok(out)
}

// ============ 系统概要 ============

/// Agent 工具：一行系统概要（OS 版本 / CPU / 内存 / 屏幕）。
/// OS 版本走注册表 CurrentVersion（ProductName + DisplayVersion + CurrentBuildNumber），
/// 不依赖 WDK/ntdll 的 RtlGetVersion。
pub fn system_info() -> Result<String, String> {
    let mut parts: Vec<String> = Vec::new();

    // OS 版本
    const CV: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
    let build = reg_read_dword(CV, "CurrentBuildNumber").or_else(|| {
        reg_read_string(CV, "CurrentBuildNumber")
            .and_then(|s| s.trim().parse::<u32>().ok())
    });
    let prod = reg_read_string(CV, "ProductName");
    let display = reg_read_string(CV, "DisplayVersion");
    match (&prod, build, &display) {
        (Some(p), Some(b), Some(d)) => parts.push(format!("{p} {d} (build {b})")),
        (Some(p), Some(b), None) => parts.push(format!("{p} (build {b})")),
        (Some(p), None, _) => parts.push(p.clone()),
        (None, Some(b), Some(d)) => {
            let base = if b >= 22000 { "Windows 11" } else { "Windows 10" };
            parts.push(format!("{base} {d} (build {b})"))
        }
        (None, Some(b), None) => {
            let base = if b >= 22000 { "Windows 11" } else { "Windows 10" };
            parts.push(format!("{base} (build {b})"))
        }
        (None, None, _) => {}
    }

    // CPU（第一个处理器的 ProcessorNameString）
    const CPU: &str = r"HARDWARE\DESCRIPTION\System\CentralProcessor\0";
    if let Some(c) = reg_read_string(CPU, "ProcessorNameString") {
        parts.push(c);
    }

    // 内存
    {
        use windows::Win32::System::SystemInformation::{
            GlobalMemoryStatusEx, MEMORYSTATUSEX,
        };
        let mut mem = MEMORYSTATUSEX::default();
        mem.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        if unsafe { GlobalMemoryStatusEx(&mut mem) }.is_ok() && mem.ullTotalPhys > 0 {
            let g = 1024u64 * 1024 * 1024;
            let total_gb = mem.ullTotalPhys as f64 / g as f64;
            let used_gb = (mem.ullTotalPhys - mem.ullAvailPhys) as f64 / g as f64;
            parts.push(format!("内存 {used_gb:.1}/{total_gb:.1}GB"));
        }
    }

    // 屏幕（物理分辨率 + 系统 DPI）
    {
        use windows::Win32::UI::HiDpi::GetDpiForSystem;
        use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};
        let w = unsafe { GetSystemMetrics(SM_CXSCREEN) };
        let h = unsafe { GetSystemMetrics(SM_CYSCREEN) };
        let dpi = unsafe { GetDpiForSystem() };
        if w > 0 && h > 0 {
            let mut s = format!("屏幕 {w}×{h}");
            if dpi > 0 {
                s.push_str(&format!(" @ {dpi} DPI"));
            }
            parts.push(s);
        }
    }

    if parts.is_empty() {
        return Err("无法获取系统信息（注册表与 Win32 查询均失败）".to_string());
    }
    Ok(parts.join(" · "))
}

// ============ 最近文档 ============

/// 28 种常见文档/代码/数据扩展名（M3）。
const RECENT_EXTS: &[&str] = &[
    "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pdf", "md", "txt", "csv",
    "json", "js", "ts", "py", "rs", "go", "c", "cpp", "h", "java",
    "html", "css", "sh", "ps1", "ipynb", "log", "yaml", "yml",
];

const MAX_AGE: Duration = Duration::from_secs(48 * 3600);
const MAX_SIZE: u64 = 50 * 1024 * 1024;
const MAX_ITEMS: usize = 15;

/// Agent 工具：桌面/文档/下载 顶层扫最近 48h 文档。
pub fn recent_documents() -> Result<String, String> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(d) = dirs::desktop_dir() {
        dirs.push(d);
    }
    if let Some(d) = dirs::document_dir() {
        dirs.push(d);
    }
    if let Some(d) = dirs::download_dir() {
        dirs.push(d);
    }
    Ok(recent_documents_in(&dirs, SystemTime::now()))
}

/// 纯函数核心（可单测）：扫各目录顶层，按 mtime 倒序取 15 条。
fn recent_documents_in(dirs: &[PathBuf], now: SystemTime) -> String {
    let mut found: Vec<(SystemTime, String, String, u64)> = Vec::new();
    for d in dirs {
        let label = d
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "?".to_string());
        let Ok(entries) = std::fs::read_dir(d) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            if !ft.is_file() {
                continue;
            }
            let raw_name = entry.file_name();
            let Some(name) = raw_name.to_str().map(|s| s.to_string()) else {
                continue;
            };
            let ext = std::path::Path::new(&name)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if !RECENT_EXTS.contains(&ext.as_str()) {
                continue;
            }
            let Ok(md) = entry.metadata() else {
                continue;
            };
            if md.len() > MAX_SIZE {
                continue;
            }
            let Ok(mtime) = md.modified() else {
                continue;
            };
            if now.duration_since(mtime).map(|d| d > MAX_AGE).unwrap_or(false) {
                continue;
            }
            found.push((mtime, label.clone(), name, md.len()));
        }
    }
    if found.is_empty() {
        return "（桌面/文档/下载里没有最近 48 小时修改过的文档。）".to_string();
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    let mut out: Vec<String> = found
        .iter()
        .take(MAX_ITEMS)
        .map(|(t, dir, name, size)| {
            format!("- {name}（{dir}，{}，{}）", human_size(*size), relative_cn(*t, now))
        })
        .collect();
    if found.len() > MAX_ITEMS {
        out.push(format!("（另有 {} 条未显示。）", found.len() - MAX_ITEMS));
    }
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_test_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "aibar-sysinfo-test-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("create");
        d
    }

    #[test]
    fn wide_to_string_stops_at_nul() {
        assert_eq!(wide_to_string(&[72, 105, 0, 0, 0]), "Hi");
        assert_eq!(wide_to_string(&[0, 0, 0u16]), "");
    }

    #[test]
    fn human_size_buckets() {
        assert_eq!(human_size(0), "0B");
        assert_eq!(human_size(999), "999B");
        assert_eq!(human_size(2048), "2KB");
        assert_eq!(human_size(2 * 1024 * 1024), "2MB");
        assert_eq!(human_size(3_670_016), "3.5MB");
    }

    #[test]
    fn relative_cn_buckets() {
        let now = SystemTime::now();
        assert_eq!(relative_cn(now, now), "刚刚");
        assert_eq!(relative_cn(now - Duration::from_secs(30), now), "刚刚");
        assert_eq!(relative_cn(now - Duration::from_secs(3600), now), "1小时前");
        assert_eq!(
            relative_cn(now - Duration::from_secs(5 * 86400), now),
            "5天前"
        );
    }

    #[test]
    fn recent_documents_empty_dir() {
        let d = temp_test_dir("empty");
        let out = recent_documents_in(&[d.clone()], SystemTime::now());
        assert!(out.contains("最近 48 小时"), "实际：{out}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn recent_documents_filters() {
        let d = temp_test_dir("filter");
        std::fs::write(d.join("a.txt"), b"hello").unwrap();
        std::fs::write(d.join("a.bin"), b"hello").unwrap(); // 扩展名过滤
        let big = std::fs::File::create(d.join("big.txt")).unwrap();
        big.set_len(51 * 1024 * 1024).unwrap(); // 稀疏 51MB > 50MB
        std::fs::create_dir(d.join("sub.md")).unwrap(); // 目录同名，排除
        let out = recent_documents_in(&[d.clone()], SystemTime::now());
        assert!(out.contains("- a.txt（"), "实际：{out}");
        assert!(out.contains("刚刚"), "实际：{out}");
        assert!(!out.contains("a.bin"), "实际：{out}");
        assert!(!out.contains("big.txt"), "实际：{out}");
        assert!(!out.contains("sub.md"), "实际：{out}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn foreground_window_returns_ok() {
        // 环境宽松断言：前台是窗口或桌面都合法，只要求 Ok 且非空。
        let out = foreground_window().expect("foreground_window 不应失败");
        assert!(!out.trim().is_empty());
    }

    #[test]
    fn system_info_nonempty() {
        // 正常 Windows 机器上注册表查询应至少成功一项。
        let out = system_info().expect("system_info 不应失败");
        assert!(!out.trim().is_empty());
    }
}
