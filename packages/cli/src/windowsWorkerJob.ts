const MAX_WINDOWS_JOB_FRAME_CHARS = 1_048_576;

/** One UTF-8 JSON line; embedded newlines stay escaped and never frame the prompt. */
export function windowsJobFrame(payload: { exe: string; args: string[]; cwd: string; input: string }): string {
  const frame = JSON.stringify(payload);
  if (frame.length > MAX_WINDOWS_JOB_FRAME_CHARS) throw new Error('Windows worker launch payload exceeds 1,048,576 characters.');
  return frame + '\n';
}

/** Static launcher; its stdin carries launch parameters. Secrets never enter its command line. */
const script = String.raw`
$ErrorActionPreference='Stop'
$env:PSModulePath=$PSHOME+'\Modules'
try {
  Import-Module -Name ($PSHOME+'\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
} catch { [Console]::Error.WriteLine('STMA Windows job utility import failed.'); exit 126 }
$source = @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Threading;
public static class StmaJob {
  public static string ReadFrame() {
    using(var reader=new StreamReader(Console.OpenStandardInput(),new UTF8Encoding(false,true),false,4096,true)) {
      var frame=new StringBuilder();
      for(;;) {
        int value=reader.Read();
        if(value<0)throw new InvalidDataException("Incomplete Windows job frame");
        if(value==10)return frame.ToString();
        if(frame.Length>=${MAX_WINDOWS_JOB_FRAME_CHARS})throw new InvalidDataException("Windows job frame too large");
        frame.Append((char)value);
      }
    }
  }
  [StructLayout(LayoutKind.Sequential)] struct SA { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI { public int cb; public string reserved, desktop, title; public int x,y,xs,ys,xc,yc,fill,flags; public short show,cbReserved; public IntPtr reserved2,stdin,stdout,stderr; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public int pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long perProcess,perJob; public uint flags; public UIntPtr min,max; public uint activeLimit; public UIntPtr affinity; public uint priority,scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong readOp,writeOp,otherOp,readBytes,writeBytes,otherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC basic; public IO io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNT { public long user,kernel,totalUser,totalKernel; public uint faults,totalProcesses,activeProcesses,terminated; }
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a,string n);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref EXT info,uint len);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,ref ACCOUNT info,uint len,IntPtr ret);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr r,out IntPtr w,ref SA sa,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr h,uint mask,uint flags);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SI si,out PI pi);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool WriteFile(IntPtr h,byte[] b,uint count,out uint wrote,IntPtr ov);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int h);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static string Quote(string s) { var b=new StringBuilder("\""); int slash=0; foreach(char c in s){ if(c=='\\'){slash++;continue;} if(c=='\"'){b.Append('\\',slash*2+1);b.Append(c);slash=0;continue;} b.Append('\\',slash);slash=0;b.Append(c); } b.Append('\\',slash*2);b.Append('\"');return b.ToString(); }
  static void Check(bool ok){if(!ok)throw new InvalidOperationException("Windows job operation failed");}
  public static int Run(string exe,string[] args,string cwd,string input) {
    IntPtr job=IntPtr.Zero, read=IntPtr.Zero, write=IntPtr.Zero; PI pi=new PI();
    try {
      job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
      EXT limits=new EXT(); limits.basic.flags=0x2000; Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(EXT))));
      SA sa=new SA();sa.nLength=Marshal.SizeOf(typeof(SA));sa.bInheritHandle=true;Check(CreatePipe(out read,out write,ref sa,0));Check(SetHandleInformation(write,1,0));
      SI si=new SI();si.cb=Marshal.SizeOf(typeof(SI));si.flags=0x100;si.stdin=read;si.stdout=GetStdHandle(-11);si.stderr=GetStdHandle(-12);
      var command=new StringBuilder(Quote(exe));foreach(string arg in args){command.Append(' ');command.Append(Quote(arg));}
      Check(CreateProcess(exe,command,IntPtr.Zero,IntPtr.Zero,true,0x4|0x08000000,IntPtr.Zero,cwd,ref si,out pi));
      if(!AssignProcessToJobObject(job,pi.process)){TerminateProcess(pi.process,1);throw new InvalidOperationException("Windows job assignment failed");}
      CloseHandle(read);read=IntPtr.Zero;Check(ResumeThread(pi.thread)!=0xffffffff);
      byte[] bytes=Encoding.UTF8.GetBytes(input);uint count=0; if(bytes.Length>0)Check(WriteFile(write,bytes,(uint)bytes.Length,out count,IntPtr.Zero)&&count==bytes.Length);
      CloseHandle(write);write=IntPtr.Zero;Check(WaitForSingleObject(pi.process,0xffffffff)==0);uint exit;Check(GetExitCodeProcess(pi.process,out exit));
      ACCOUNT account=new ACCOUNT();Check(QueryInformationJobObject(job,1,ref account,(uint)Marshal.SizeOf(typeof(ACCOUNT)),IntPtr.Zero));
      for(int i=0;i<20 && account.activeProcesses!=0;i++){Thread.Sleep(50);Check(QueryInformationJobObject(job,1,ref account,(uint)Marshal.SizeOf(typeof(ACCOUNT)),IntPtr.Zero));}
      if(account.activeProcesses!=0){Check(TerminateJobObject(job,125));for(int i=0;i<100 && account.activeProcesses!=0;i++){Thread.Sleep(50);Check(QueryInformationJobObject(job,1,ref account,(uint)Marshal.SizeOf(typeof(ACCOUNT)),IntPtr.Zero));}if(account.activeProcesses!=0)throw new InvalidOperationException("Windows job did not stop");return 125;}
      return exit>255?1:(int)exit;
    } finally { if(write!=IntPtr.Zero)CloseHandle(write);if(read!=IntPtr.Zero)CloseHandle(read);if(pi.thread!=IntPtr.Zero)CloseHandle(pi.thread);if(pi.process!=IntPtr.Zero)CloseHandle(pi.process);if(job!=IntPtr.Zero)CloseHandle(job); }
  }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
try {
  $frame = [StmaJob]::ReadFrame()
  $payload = $frame | ConvertFrom-Json
} catch { [Console]::Error.WriteLine('STMA Windows job payload refused.'); exit 126 }
try { $argsArray = @($payload.args | ForEach-Object { [string]$_ }); $result=[StmaJob]::Run([string]$payload.exe,[string[]]$argsArray,[string]$payload.cwd,[string]$payload.input); exit $result } catch { [Console]::Error.WriteLine('STMA Windows job containment failed.'); exit 126 }
`;

export function windowsJobCommand(): { executable: string; args: string[] } {
  const root = process.env.SystemRoot ?? 'C:\\Windows';
  return {
    executable: `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
  };
}
