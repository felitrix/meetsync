param([switch]$Set, [switch]$Get, [switch]$Delete)

$source = @"
using System;
using System.Runtime.InteropServices;
public static class MeetSyncCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Credential {
    public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist;
    public UInt32 AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("Advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredWrite(ref Credential credential, UInt32 flags);
  [DllImport("Advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("Advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
  [DllImport("Advapi32.dll", SetLastError=true)] public static extern void CredFree(IntPtr buffer);
}
"@
Add-Type -TypeDefinition $source
$target = 'MeetSync.NVIDIA.ApiKey'

if ($Set) {
  $secure = Read-Host 'Cole a chave NVIDIA (ela nao sera exibida)' -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    if ($plain -notmatch '^nvapi-[A-Za-z0-9_-]{20,}$') { throw 'Formato de chave NVIDIA invalido.' }
    $blob = [Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($plain)
    try {
      $cred = New-Object MeetSyncCredential+Credential
      $cred.Type = 1; $cred.TargetName = $target; $cred.UserName = 'MeetSync'
      $cred.CredentialBlob = $blob; $cred.CredentialBlobSize = [Text.Encoding]::Unicode.GetByteCount($plain)
      $cred.Persist = 2
      if (-not [MeetSyncCredential]::CredWrite([ref]$cred, 0)) { throw "CredWrite falhou: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
      Write-Host 'Chave NVIDIA salva no Gerenciador de Credenciais do Windows.'
    } finally { [Runtime.InteropServices.Marshal]::FreeCoTaskMem($blob) }
  } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  exit 0
}

if ($Get) {
  $ptr = [IntPtr]::Zero
  if (-not [MeetSyncCredential]::CredRead($target, 1, 0, [ref]$ptr)) { exit 2 }
  try {
    $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][MeetSyncCredential+Credential])
    [Runtime.InteropServices.Marshal]::PtrToStringUni($cred.CredentialBlob, [int]($cred.CredentialBlobSize / 2))
  } finally { [MeetSyncCredential]::CredFree($ptr) }
  exit 0
}

if ($Delete) {
  [void][MeetSyncCredential]::CredDelete($target, 1, 0)
  Write-Host 'Credencial removida.'
  exit 0
}

Write-Error 'Use -Set, -Get ou -Delete.'
exit 1
