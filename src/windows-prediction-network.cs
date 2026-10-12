// App-only worker. Windows owns PAC/WPAD, proxy authentication and TLS trust.
// Requests and response chunks exist only in anonymous pipes, never files.
using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

public static class CCDXPredictionNetwork {
  [DllImport("winhttp.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr WinHttpOpen(string agent, uint access, string proxy, string bypass, uint flags);
  [DllImport("winhttp.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr WinHttpConnect(IntPtr session, string host, ushort port, uint reserved);
  [DllImport("winhttp.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr WinHttpOpenRequest(IntPtr connection, string method, string path, string version, string referer, IntPtr accept, uint flags);
  [DllImport("winhttp.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool WinHttpSendRequest(IntPtr request, string headers, uint headerLength, byte[] body, uint bodyLength, uint total, IntPtr context);
  [DllImport("winhttp.dll", SetLastError=true)] static extern bool WinHttpReceiveResponse(IntPtr request, IntPtr reserved);
  [DllImport("winhttp.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool WinHttpQueryHeaders(IntPtr request, uint info, string name, IntPtr buffer, ref uint length, IntPtr index);
  [DllImport("winhttp.dll", SetLastError=true)] static extern bool WinHttpReadData(IntPtr request, byte[] buffer, uint length, out uint read);
  [DllImport("winhttp.dll", SetLastError=true)] static extern bool WinHttpWriteData(IntPtr request, byte[] buffer, uint length, out uint written);
  [DllImport("winhttp.dll", SetLastError=true)] static extern bool WinHttpSetOption(IntPtr handle, uint option, ref uint value, uint size);
  [DllImport("winhttp.dll", SetLastError=true)] static extern bool WinHttpSetTimeouts(IntPtr handle, int resolve, int connect, int send, int receive);
  [DllImport("winhttp.dll", SetLastError=true)] static extern bool WinHttpCloseHandle(IntPtr handle);
  [DllImport("winhttp.dll", SetLastError=true)] static extern bool WinHttpDetectAutoProxyConfigUrl(uint flags, out IntPtr url);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr pointer);
  static readonly object outputLock = new object(), stateLock = new object();
  static readonly Dictionary<int, Work> active = new Dictionary<int, Work>();
  static readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength=2*1024*1024 };
  static IntPtr session;
  class Work { public IntPtr handle; public ManualResetEventSlim ack = new ManualResetEventSlim(false); public BlockingCollection<byte[]> upload = new BlockingCollection<byte[]>(2); public bool cancelled; }
  static void Check(bool ok) { if(!ok) throw new IOException("winhttp_" + Marshal.GetLastWin32Error()); }
  static void Emit(object value) { lock(outputLock) { Console.Out.WriteLine(json.Serialize(value)); Console.Out.Flush(); } }
  static string Headers(IntPtr request) {
    uint length=0;
    WinHttpQueryHeaders(request,22,null,IntPtr.Zero,ref length,IntPtr.Zero);
    if(length>65536 || length==0) throw new IOException("winhttp_headers_limit");
    IntPtr memory=Marshal.AllocHGlobal((int)length);
    try { Check(WinHttpQueryHeaders(request,22,null,memory,ref length,IntPtr.Zero)); return Marshal.PtrToStringUni(memory); }
    finally { Marshal.FreeHGlobal(memory); }
  }
  static IntPtr Open(Uri url, string method, out IntPtr connection) {
    connection=WinHttpConnect(session,url.Host,(ushort)url.Port,0);
    Check(connection!=IntPtr.Zero);
    IntPtr request=WinHttpOpenRequest(connection,method,url.PathAndQuery,null,null,IntPtr.Zero,url.Scheme=="https"?0x00800000u:0u);
    Check(request!=IntPtr.Zero);
    // Disable cookies and automatic redirects. Never relax certificate checks
    // or broaden the OS default-credential policy to arbitrary origin servers.
    uint disable=3;
    if(!WinHttpSetOption(request,63,ref disable,4)){WinHttpCloseHandle(request);throw new IOException("winhttp_request_options_failed");}
    return request;
  }
  static string ReadPac(string address) {
    Uri uri;
    if(!Uri.TryCreate(address,UriKind.Absolute,out uri) || (uri.Scheme!="http"&&uri.Scheme!="https") || uri.UserInfo.Length!=0 || uri.Fragment.Length!=0)
      throw new IOException("winhttp_pac_url_invalid");
    IntPtr connection=IntPtr.Zero, request=IntPtr.Zero;
    try {
      request=Open(uri,"GET",out connection);
      Check(WinHttpSendRequest(request,"Accept-Encoding: identity\r\n",uint.MaxValue,null,0,0,IntPtr.Zero));
      Check(WinHttpReceiveResponse(request,IntPtr.Zero));
      string headers=Headers(request);
      if(!headers.StartsWith("HTTP/1.1 200 ")&&!headers.StartsWith("HTTP/1.0 200 ")&&!headers.StartsWith("HTTP/2 200 ")) throw new IOException("winhttp_pac_http_error");
      using(var stream=new MemoryStream()) {
        byte[] bytes=new byte[16384];uint read;
        while(true) { Check(WinHttpReadData(request,bytes,(uint)bytes.Length,out read));if(read==0)break;
          if(stream.Length+read>1024*1024)throw new IOException("winhttp_pac_limit");stream.Write(bytes,0,(int)read); }
        return Convert.ToBase64String(stream.ToArray());
      }
    } finally { if(request!=IntPtr.Zero)WinHttpCloseHandle(request);if(connection!=IntPtr.Zero)WinHttpCloseHandle(connection); }
  }
  static void Request(Dictionary<string,object> data, int id, Work work) {
    IntPtr connection=IntPtr.Zero;
    try {
      var uri=new Uri((string)data["url"]);
      if(uri.Scheme!="https" || uri.Port!=443 || uri.UserInfo.Length!=0 || uri.Fragment.Length!=0 || (uri.Host!="chatgpt.com"&&uri.Host!="ab.chatgpt.com")) throw new IOException("winhttp_target_invalid");
      var method=(string)data["method"];
      if(method!="GET"&&method!="POST"&&method!="HEAD"&&method!="PUT"&&method!="DELETE"&&method!="OPTIONS"&&method!="PATCH")throw new IOException("winhttp_method_invalid");
      var headers=(string)data["headers"];
      long length=Convert.ToInt64(data["length"]);
      if(headers.Length>32768 || length>uint.MaxValue)throw new IOException("winhttp_request_limit");
      bool chunked=length<0;
      if(chunked)headers+="Transfer-Encoding: chunked\r\n";
      IntPtr request=Open(uri,method,out connection);
      lock(stateLock) { if(work.cancelled) {WinHttpCloseHandle(request);return;}work.handle=request; }
      Check(WinHttpSendRequest(request,headers,uint.MaxValue,null,0,chunked?0:(uint)length,IntPtr.Zero));
      long uploaded=0;
      foreach(var part in work.upload.GetConsumingEnumerable()) {
        if(work.cancelled)return;
        uploaded+=part.Length;
        if(!chunked&&uploaded>length)throw new IOException("winhttp_upload_length_invalid");
        byte[] bytes=part;
        if(chunked) {
          byte[] prefix=Encoding.ASCII.GetBytes(part.Length.ToString("X")+"\r\n");
          bytes=new byte[prefix.Length+part.Length+2];Buffer.BlockCopy(prefix,0,bytes,0,prefix.Length);Buffer.BlockCopy(part,0,bytes,prefix.Length,part.Length);bytes[bytes.Length-2]=13;bytes[bytes.Length-1]=10;
        }
        uint written;Check(WinHttpWriteData(request,bytes,(uint)bytes.Length,out written));
        if(written!=bytes.Length)throw new IOException("winhttp_upload_write_failed");
        Emit(new {id=id,type="upload_ack"});
      }
      if(work.cancelled)return;
      if(!chunked&&uploaded!=length)throw new IOException("winhttp_upload_length_invalid");
      if(chunked){byte[] last=Encoding.ASCII.GetBytes("0\r\n\r\n");uint written;Check(WinHttpWriteData(request,last,(uint)last.Length,out written));}
      Check(WinHttpReceiveResponse(request,IntPtr.Zero));
      Emit(new {id=id,type="headers",headers=Headers(request)});
      byte[] buffer=new byte[16384];uint read;
      while(true) {
        Check(WinHttpReadData(request,buffer,(uint)buffer.Length,out read));if(read==0)break;
        work.ack.Reset();Emit(new {id=id,type="data",body=Convert.ToBase64String(buffer,0,(int)read)});
        if(!work.ack.Wait(30000))throw new IOException("winhttp_consumer_timeout");
        if(work.cancelled)return;
      }
      Emit(new {id=id,type="end"});
    } catch(Exception error) {
      // Native error codes only: no URLs, headers, cookies or account details.
      Emit(new {id=id,type="error",code=error is IOException?error.Message:"winhttp_request_failed"});
    } finally {
      lock(stateLock) { if(work.handle!=IntPtr.Zero)WinHttpCloseHandle(work.handle);active.Remove(id); }
      if(connection!=IntPtr.Zero)WinHttpCloseHandle(connection);
      work.ack.Dispose();work.upload.Dispose();
    }
  }
  public static void Run() {
    Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);
    session=WinHttpOpen("CCDX native prediction",4,null,null,0);
    try {
      Check(session!=IntPtr.Zero);Check(WinHttpSetTimeouts(session,10000,10000,30000,30000));
      uint protocols=0x800;Check(WinHttpSetOption(session,84,ref protocols,4));
      var initial=json.Deserialize<Dictionary<string,object>>(Console.ReadLine());
      string pac=(string)initial["pac"];
      if(string.IsNullOrWhiteSpace(pac)&&(bool)initial["autoDetect"]) {
        IntPtr address;
        if(WinHttpDetectAutoProxyConfigUrl(3,out address)) {try{pac=Marshal.PtrToStringUni(address);}finally{GlobalFree(address);}}
        else if(Marshal.GetLastWin32Error()!=12180)throw new IOException("winhttp_wpad_discovery_failed");
      }
      Emit(new {type="ready",pac=string.IsNullOrWhiteSpace(pac)?null:ReadPac(pac)});
      string line;
      while((line=Console.ReadLine())!=null) {
        if(line.Length>800000)throw new IOException("winhttp_input_limit");
        var data=json.Deserialize<Dictionary<string,object>>(line);int id=Convert.ToInt32(data["id"]);string op=(string)data["op"];
        lock(stateLock) {
          Work existing;
          if(op=="ack") {if(active.TryGetValue(id,out existing))existing.ack.Set();continue;}
          if(op=="cancel") {if(active.TryGetValue(id,out existing)){existing.cancelled=true;existing.ack.Set();existing.upload.CompleteAdding();if(existing.handle!=IntPtr.Zero){WinHttpCloseHandle(existing.handle);existing.handle=IntPtr.Zero;}}continue;}
          if(op=="upload") {if(active.TryGetValue(id,out existing)){var bytes=Convert.FromBase64String((string)data["body"]);if(bytes.Length>65536||!existing.upload.TryAdd(bytes))throw new IOException("winhttp_upload_limit");}continue;}
          if(op=="upload_end") {if(active.TryGetValue(id,out existing))existing.upload.CompleteAdding();continue;}
          if(op!="request"||id<1||active.ContainsKey(id)||active.Count>=32){Emit(new {id=id,type="error",code="winhttp_admission_limit"});continue;}
          var work=new Work();active.Add(id,work);Task.Run(()=>Request(data,id,work));
        }
      }
    } catch(Exception error) { Emit(new {type="error",code=error is IOException?error.Message:"winhttp_worker_failed"}); }
    finally { lock(stateLock) {foreach(var work in active.Values){work.cancelled=true;work.ack.Set();work.upload.CompleteAdding();if(work.handle!=IntPtr.Zero){WinHttpCloseHandle(work.handle);work.handle=IntPtr.Zero;}}}if(session!=IntPtr.Zero)WinHttpCloseHandle(session); }
  }
}
