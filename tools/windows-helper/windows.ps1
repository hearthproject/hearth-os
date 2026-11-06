param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("doctor", "observe", "action")]
  [string]$Mode,
  [string]$InputBase64 = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$script:FailCode = "HELPER_ERROR"

function Fail([string]$code, [string]$message) {
  $script:FailCode = $code
  throw $message
}

function Write-Result($value) {
  $value | ConvertTo-Json -Compress -Depth 10
  exit 0
}

$nativeSource = @'
using System;
using System.Runtime.InteropServices;

public static class HearthNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx; public int dy; public uint mouseData; public uint dwFlags;
        public uint time; public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk; public ushort wScan; public uint dwFlags;
        public uint time; public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUTUNION u; }

    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint count, INPUT[] inputs, int size);

    public const uint INPUT_KEYBOARD = 1;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;

    public static void SendUnicodeChar(char value, bool keyUp)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].u.ki.wScan = (ushort)value;
        inputs[0].u.ki.dwFlags = KEYEVENTF_UNICODE | (keyUp ? KEYEVENTF_KEYUP : 0);
        if (SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT))) != 1) throw new InvalidOperationException("SendInput unicode failed");
    }

    public static void SendVirtualKey(ushort key, bool keyUp)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].u.ki.wVk = key;
        inputs[0].u.ki.dwFlags = keyUp ? KEYEVENTF_KEYUP : 0;
        if (SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT))) != 1) throw new InvalidOperationException("SendInput key failed");
    }
}
'@

Add-Type -TypeDefinition $nativeSource -Language CSharp
[HearthNative]::SetProcessDPIAware() | Out-Null

$supportsCapture = $true
$supportsUia = $true
$captureError = $null
$uiaError = $null
try { Add-Type -AssemblyName System.Drawing } catch { $supportsCapture = $false; $captureError = $_.Exception.Message }
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
} catch {
  $supportsUia = $false
  $uiaError = $_.Exception.Message
}

function Get-InputObject {
  if ([string]::IsNullOrWhiteSpace($InputBase64)) { return @{} }
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($InputBase64))
  return $json | ConvertFrom-Json
}

function Get-ForegroundInfo {
  $handle = [HearthNative]::GetForegroundWindow()
  if ($handle -eq [IntPtr]::Zero) { Fail "NO_FOREGROUND_WINDOW" "No foreground window was found" }
  $rect = New-Object HearthNative+RECT
  if (-not [HearthNative]::GetWindowRect($handle, [ref]$rect)) { Fail "WINDOW_RECT_FAILED" "Could not read the window bounds" }
  [uint32]$processId = 0
  [HearthNative]::GetWindowThreadProcessId($handle, [ref]$processId) | Out-Null
  $process = Get-Process -Id $processId -ErrorAction Stop
  $titleBuffer = New-Object Text.StringBuilder 512
  [HearthNative]::GetWindowText($handle, $titleBuffer, $titleBuffer.Capacity) | Out-Null
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -le 0 -or $height -le 0) { Fail "WINDOW_NOT_VISIBLE" "The foreground window is not visible" }
  return [pscustomobject]@{
    handle = $handle.ToInt64()
    processId = [int]$processId
    app = $process.ProcessName.ToLowerInvariant()
    windowTitle = $titleBuffer.ToString()
    left = $rect.Left
    top = $rect.Top
    width = $width
    height = $height
  }
}

function Assert-ExpectedApp($foreground, [string]$expectedApp) {
  if (-not [string]::IsNullOrWhiteSpace($expectedApp) -and $foreground.app -ne $expectedApp.ToLowerInvariant()) {
    Fail "FOREGROUND_MISMATCH" "Foreground app is $($foreground.app), not the approved $expectedApp"
  }
}

function Get-IdleMilliseconds {
  $info = New-Object HearthNative+LASTINPUTINFO
  $info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type][HearthNative+LASTINPUTINFO])
  if (-not [HearthNative]::GetLastInputInfo([ref]$info)) { return [int64]10000 }
  [int64]$now = [Environment]::TickCount
  [int64]$last = [uint32]$info.dwTime
  [int64]$elapsed = $now - $last
  while ($elapsed -lt 0) { $elapsed += 4294967296 }
  return $elapsed
}

function Assert-UserIdle {
  if ((Get-IdleMilliseconds) -lt 500) { Fail "USER_INPUT_RECENT" "Recent user input detected; automatic input was stopped" }
}

function Wait-UserIdle([int]$timeoutMilliseconds = 3000) {
  $watch = [Diagnostics.Stopwatch]::StartNew()
  while ($watch.ElapsedMilliseconds -lt $timeoutMilliseconds) {
    if ((Get-IdleMilliseconds) -ge 500) { return }
    Start-Sleep -Milliseconds 120
  }
  Fail "USER_INPUT_RECENT" "Recent user input detected; the target app was not focused"
}

function Focus-AppWindow([string]$targetApp, [string]$windowTitle) {
  $targetApp = $targetApp.ToLowerInvariant()
  $candidates = Get-Process | Where-Object {
    $_.ProcessName.ToLowerInvariant() -eq $targetApp -and $_.MainWindowHandle -ne [IntPtr]::Zero
  }
  if (-not [string]::IsNullOrWhiteSpace($windowTitle)) {
    $candidates = $candidates | Where-Object { $_.MainWindowTitle -like "*$windowTitle*" }
  }
  $target = $candidates | Select-Object -First 1
  if ($null -eq $target) { Fail "APP_WINDOW_NOT_FOUND" "No visible window was found for $targetApp" }

  Wait-UserIdle
  $handle = [IntPtr]$target.MainWindowHandle
  [HearthNative]::ShowWindow($handle, 9) | Out-Null
  $foregroundHandle = [HearthNative]::GetForegroundWindow()
  if ($foregroundHandle -ne $handle) {
    [uint32]$foregroundProcessId = 0
    $foregroundThread = [HearthNative]::GetWindowThreadProcessId($foregroundHandle, [ref]$foregroundProcessId)
    $attached = [HearthNative]::AttachThreadInput([HearthNative]::GetCurrentThreadId(), $foregroundThread, $true)
    try {
      [HearthNative]::BringWindowToTop($handle) | Out-Null
      [HearthNative]::SetForegroundWindow($handle) | Out-Null
    } finally {
      if ($attached) { [HearthNative]::AttachThreadInput([HearthNative]::GetCurrentThreadId(), $foregroundThread, $false) | Out-Null }
    }
    if ([HearthNative]::GetForegroundWindow() -ne $handle) {
      [HearthNative]::SwitchToThisWindow($handle, $false)
    }
  }
  Start-Sleep -Milliseconds 180
  $foreground = Get-ForegroundInfo
  if ($foreground.app -ne $targetApp) { Fail "FOCUS_DENIED" "Windows kept focus on $($foreground.app) instead of $targetApp" }
  return $foreground
}

function Capture-Foreground([string]$expectedApp) {
  if (-not $supportsCapture) { Fail "CAPTURE_UNAVAILABLE" "Screen capture is unavailable: $captureError" }
  $foreground = Get-ForegroundInfo
  Assert-ExpectedApp $foreground $expectedApp
  $bitmap = New-Object Drawing.Bitmap $foreground.width, $foreground.height
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($foreground.left, $foreground.top, 0, 0, $bitmap.Size, [Drawing.CopyPixelOperation]::SourceCopy)
  } finally {
    $graphics.Dispose()
  }
  $outputBitmap = $bitmap
  if ($bitmap.Width -gt 1600) {
    $scale = 1600 / $bitmap.Width
    $scaledWidth = [int][Math]::Round($bitmap.Width * $scale)
    $scaledHeight = [int][Math]::Round($bitmap.Height * $scale)
    $outputBitmap = New-Object Drawing.Bitmap $scaledWidth, $scaledHeight
    $scaledGraphics = [Drawing.Graphics]::FromImage($outputBitmap)
    try {
      $scaledGraphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $scaledGraphics.DrawImage($bitmap, 0, 0, $scaledWidth, $scaledHeight)
    } finally {
      $scaledGraphics.Dispose()
    }
  }
  $stream = New-Object IO.MemoryStream
  try {
    $codec = [Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" } | Select-Object -First 1
    $encoder = New-Object Drawing.Imaging.EncoderParameters 1
    $encoder.Param[0] = New-Object Drawing.Imaging.EncoderParameter ([Drawing.Imaging.Encoder]::Quality), ([int64]70)
    $outputBitmap.Save($stream, $codec, $encoder)
    $base64 = [Convert]::ToBase64String($stream.ToArray())
    $outputWidth = $outputBitmap.Width
    $outputHeight = $outputBitmap.Height
  } finally {
    $stream.Dispose()
    if ($outputBitmap -ne $bitmap) { $outputBitmap.Dispose() }
    $bitmap.Dispose()
  }
  return [pscustomobject]@{
    ok = $true
    jpegBase64 = $base64
    width = $outputWidth
    height = $outputHeight
    activeApp = $foreground.app
    windowTitle = $foreground.windowTitle
  }
}

function Invoke-UiaAction($input, $foreground) {
  if (-not $supportsUia) { Fail "UIA_UNAVAILABLE" "UI Automation is unavailable: $uiaError" }
  $root = [Windows.Automation.AutomationElement]::FromHandle([IntPtr]$foreground.handle)
  if ($null -eq $root) { Fail "UIA_WINDOW_UNAVAILABLE" "Could not read UI elements in the current window" }
  $conditions = @()
  $conditions += [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, [string]$input.elementName)
  if (-not [string]::IsNullOrWhiteSpace([string]$input.controlType)) {
    switch ([string]$input.controlType) {
      "Button" { $type = [Windows.Automation.ControlType]::Button }
      "MenuItem" { $type = [Windows.Automation.ControlType]::MenuItem }
      "Edit" { $type = [Windows.Automation.ControlType]::Edit }
      "ListItem" { $type = [Windows.Automation.ControlType]::ListItem }
      "TabItem" { $type = [Windows.Automation.ControlType]::TabItem }
      "Hyperlink" { $type = [Windows.Automation.ControlType]::Hyperlink }
      "CheckBox" { $type = [Windows.Automation.ControlType]::CheckBox }
      "ComboBox" { $type = [Windows.Automation.ControlType]::ComboBox }
      "TreeItem" { $type = [Windows.Automation.ControlType]::TreeItem }
      default { Fail "UIA_CONTROL_TYPE" "Unsupported control type: $($input.controlType)" }
    }
    $conditions += [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, $type)
  }
  $condition = if ($conditions.Count -eq 1) { $conditions[0] } else { [Windows.Automation.AndCondition]::new([Windows.Automation.Condition[]]$conditions) }
  $element = $root.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
  if ($null -eq $element) { Fail "UIA_ELEMENT_NOT_FOUND" "No UI element named $($input.elementName) was found" }
  if ($input.kind -eq "uia.setvalue") {
    try {
      $pattern = [Windows.Automation.ValuePattern]$element.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
      $pattern.SetValue([string]$input.value)
      return "ValuePattern"
    } catch {
      Fail "UIA_VALUE_UNSUPPORTED" "This UI element does not support value writes"
    }
  }
  try {
    $pattern = [Windows.Automation.InvokePattern]$element.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
    return "InvokePattern"
  } catch {}
  try {
    $pattern = [Windows.Automation.SelectionItemPattern]$element.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)
    $pattern.Select()
    return "SelectionItemPattern"
  } catch {}
  try {
    $pattern = [Windows.Automation.TogglePattern]$element.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)
    $pattern.Toggle()
    return "TogglePattern"
  } catch {}
  try {
    $pattern = [Windows.Automation.ExpandCollapsePattern]$element.GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern)
    $pattern.Expand()
    return "ExpandCollapsePattern"
  } catch {}
  Fail "UIA_INVOKE_UNSUPPORTED" "This UI element does not support a low-risk invocation"
}

try {
  if ($Mode -eq "doctor") {
    $foreground = $null
    try { $foreground = Get-ForegroundInfo } catch {}
    Write-Result ([pscustomobject]@{
      ok = $supportsCapture -and $supportsUia
      mode = "doctor"
      capture = $supportsCapture
      input = $true
      uia = $supportsUia
      captureError = $captureError
      uiaError = $uiaError
      activeApp = if ($null -ne $foreground) { $foreground.app } else { $null }
      windowTitle = if ($null -ne $foreground) { $foreground.windowTitle } else { $null }
    })
  }

  $input = Get-InputObject
  if ($Mode -eq "observe") {
    $expectedApp = [string]$input.expectedApp
    if ([bool]$input.focusTarget -and -not [string]::IsNullOrWhiteSpace($expectedApp)) {
      Focus-AppWindow $expectedApp ([string]$input.windowTitle) | Out-Null
    } else {
      Assert-UserIdle
    }
    Write-Result (Capture-Foreground $expectedApp)
  }

  $kind = [string]$input.kind
  if ($kind -eq "focus") {
    $foreground = Focus-AppWindow ([string]$input.app) ([string]$input.windowTitle)
    Write-Result ([pscustomobject]@{ ok = $true; result = [pscustomobject]@{ app = $foreground.app; windowTitle = $foreground.windowTitle } })
  }

  $expectedApp = [string]$input.expectedApp
  if ([bool]$input.focusTarget -and -not [string]::IsNullOrWhiteSpace($expectedApp)) {
    Focus-AppWindow $expectedApp "" | Out-Null
  } else {
    Assert-UserIdle
  }
  $foreground = Get-ForegroundInfo
  Assert-ExpectedApp $foreground $expectedApp

  if ($kind -eq "click") {
    $x = [double]$input.x
    $y = [double]$input.y
    if ($x -lt 0 -or $x -gt 1 -or $y -lt 0 -or $y -gt 1) { Fail "INVALID_CLICK" "The click position is outside the current frame" }
    $screenX = [int]($foreground.left + ($foreground.width * $x))
    $screenY = [int]($foreground.top + ($foreground.height * $y))
    if (-not [HearthNative]::SetCursorPos($screenX, $screenY)) { Fail "CLICK_MOVE_FAILED" "Could not move the pointer" }
    [HearthNative]::mouse_event([HearthNative]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [HearthNative]::mouse_event([HearthNative]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
    Write-Result ([pscustomobject]@{ ok = $true; result = [pscustomobject]@{ x = $x; y = $y; screenX = $screenX; screenY = $screenY } })
  }

  if ($kind -eq "type") {
    $text = [string]$input.text
    foreach ($character in $text.ToCharArray()) {
      Assert-UserIdle
      $currentForeground = Get-ForegroundInfo
      Assert-ExpectedApp $currentForeground ([string]$input.expectedApp)
      [HearthNative]::SendUnicodeChar($character, $false)
      [HearthNative]::SendUnicodeChar($character, $true)
      Start-Sleep -Milliseconds 8
    }
    Write-Result ([pscustomobject]@{ ok = $true; result = [pscustomobject]@{ characters = $text.Length } })
  }

  if ($kind -eq "press") {
    $keys = [string]$input.keys
    if ($keys -eq "Enter") { [HearthNative]::SendVirtualKey(0x0D, $false); [HearthNative]::SendVirtualKey(0x0D, $true) }
    elseif ($keys -eq "Tab") { [HearthNative]::SendVirtualKey(0x09, $false); [HearthNative]::SendVirtualKey(0x09, $true) }
    elseif ($keys -eq "Escape") { [HearthNative]::SendVirtualKey(0x1B, $false); [HearthNative]::SendVirtualKey(0x1B, $true) }
    elseif ($keys -eq "Ctrl+S") {
      [HearthNative]::SendVirtualKey(0x11, $false)
      [HearthNative]::SendVirtualKey(0x53, $false)
      [HearthNative]::SendVirtualKey(0x53, $true)
      [HearthNative]::SendVirtualKey(0x11, $true)
    } else { Fail "KEY_NOT_ALLOWED" "The key combination is not on the low-risk allowlist" }
    Write-Result ([pscustomobject]@{ ok = $true; result = [pscustomobject]@{ keys = $keys } })
  }

  if ($kind -eq "uia.invoke" -or $kind -eq "uia.setvalue") {
    $pattern = Invoke-UiaAction $input $foreground
    Write-Result ([pscustomobject]@{ ok = $true; result = [pscustomobject]@{ pattern = $pattern; element = [string]$input.elementName; controlType = [string]$input.controlType } })
  }

  Fail "ACTION_NOT_ALLOWED" "This desktop action is not supported"
} catch {
  Write-Result ([pscustomobject]@{ ok = $false; code = $script:FailCode; error = $_.Exception.Message })
}
