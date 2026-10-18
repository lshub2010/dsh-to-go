// dsh-to-go native launcher (WinForms + WebView2)
// -----------------------------------------------------------------------------
// Starts tools/ui-server.js on a free local port, captures the per-run token
// from its stdout, opens a native window, and hands the token to the page over
// the WebView2 message bridge.  The token is never written to disk, never put
// in the window title, never passed on a command line and never logged.
//
// Built with the in-box C# compiler (csc.exe, .NET Framework 4.x):
//   tools/launcher/build-launcher.cmd
// -----------------------------------------------------------------------------

using System;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace DshToGo
{
    internal static class Program
    {
        internal const string AppTitle = "dsh-to-go";

        private static Mutex _instanceMutex;

        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        // WebView2 的两个托管程序集与一个原生 loader 放在 third_party\webview2\，
        // 根目录只留一个 exe。这里在加载任何 WebView2 类型之前把它们接上。
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool SetDllDirectory(string lpPathName);

        private static void HookWebView2Dependencies(string root)
        {
            string dir = System.IO.Path.Combine(root, "third_party", "webview2");
            if (!System.IO.Directory.Exists(dir)) return;
            try { SetDllDirectory(dir); } catch (Exception) { }
            AppDomain.CurrentDomain.AssemblyResolve += delegate(object sender, ResolveEventArgs args)
            {
                try
                {
                    string simple = new System.Reflection.AssemblyName(args.Name).Name;
                    string candidate = System.IO.Path.Combine(dir, simple + ".dll");
                    return System.IO.File.Exists(candidate) ? System.Reflection.Assembly.LoadFrom(candidate) : null;
                }
                catch (Exception) { return null; }
            };
        }

        [STAThread]
        private static void Main()
        {
            try { SetProcessDPIAware(); }
            catch (Exception) { }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string root = Host.FindRoot();
            HookWebView2Dependencies(root);
            Host.Root = root;
            string key = Host.InstanceKey(root);

            bool isFirst;
            _instanceMutex = new Mutex(true, "dsh-to-go-launcher-" + key, out isFirst);

            if (!isFirst)
            {
                // Second launch: do not start another server.  Poke the running
                // instance through the named event and leave immediately.
                try
                {
                    using (EventWaitHandle ev = EventWaitHandle.OpenExisting("dsh-to-go-activate-" + key))
                    {
                        ev.Set();
                    }
                }
                catch (Exception) { }
                return;
            }

            try
            {
                Application.Run(new MainForm(root, key));
            }
            finally
            {
                GC.KeepAlive(_instanceMutex);
            }
        }
    }

    internal static class Host
    {
        internal static string Root = ".";

        // Matches "?token=<base64url>" printed by ui-server.js.  Group 1 is the
        // secret; it only ever lives in memory.
        internal static readonly Regex TokenPattern =
            new Regex(@"\?token=([A-Za-z0-9_-]+)", RegexOptions.CultureInvariant);

        internal static string FindRoot()
        {
            string dir = AppDomain.CurrentDomain.BaseDirectory;
            DirectoryInfo d = new DirectoryInfo(dir);
            for (int i = 0; i < 6 && d != null; i++)
            {
                if (File.Exists(Path.Combine(d.FullName, "tools", "ui-server.js")))
                {
                    return d.FullName;
                }
                d = d.Parent;
            }
            return Path.GetFullPath(Path.Combine(dir, "..", ".."));
        }

        internal static string InstanceKey(string root)
        {
            using (SHA1 sha = SHA1.Create())
            {
                byte[] hash = sha.ComputeHash(Encoding.UTF8.GetBytes(root.ToLowerInvariant()));
                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < 6; i++)
                {
                    sb.Append(hash[i].ToString("x2", CultureInfo.InvariantCulture));
                }
                return sb.ToString();
            }
        }

        internal static string LogPath()
        {
            return Path.Combine(Root, "data", "logs", "launcher.log");
        }

        // Every line that leaves the process goes through Sanitize, so an
        // accidental token in a child's stderr can never reach the log file.
        internal static string Sanitize(string text)
        {
            if (string.IsNullOrEmpty(text)) return text;
            return TokenPattern.Replace(text, "?token=<redacted>");
        }

        internal static void Log(string message)
        {
            try
            {
                string path = LogPath();
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture)
                    + "  " + Sanitize(message) + Environment.NewLine;
                File.AppendAllText(path, line, new UTF8Encoding(false));
            }
            catch (Exception) { }
        }

        internal static int FindFreePort(int start)
        {
            for (int port = start; port < start + 200; port++)
            {
                TcpListener probe = null;
                try
                {
                    probe = new TcpListener(IPAddress.Loopback, port);
                    probe.Start();
                    return port;
                }
                catch (SocketException) { }
                finally
                {
                    if (probe != null)
                    {
                        try { probe.Stop(); }
                        catch (Exception) { }
                    }
                }
            }
            throw new InvalidOperationException("no free loopback port in range");
        }

        internal static string Quote(string value)
        {
            return "\"" + value.TrimEnd('\\') + "\"";
        }
    }

    internal sealed class MainForm : Form
    {
        private const int SW_RESTORE = 9;

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        private readonly string _root;
        private readonly EventWaitHandle _activate;
        private readonly WebView2 _web = new WebView2();

        private Process _node;
        private bool _nodeStarted;
        private bool _fallbackDone;
        private bool _webReady;
        private bool _closed;
        private bool _probeDone;

        private int _port;
        private string _token;

        internal MainForm(string root, string key)
        {
            _root = root;
            _activate = new EventWaitHandle(false, EventResetMode.AutoReset,
                "dsh-to-go-activate-" + key);

            Text = Program.AppTitle;            // fixed; never contains the token
            Size = new Size(1200, 840);
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(880, 620);
            MainMenuStrip = null;               // no menu bar
            BackColor = Color.FromArgb(24, 26, 32);
            DoubleBuffered = true;

            _web.Dock = DockStyle.Fill;
            _web.DefaultBackgroundColor = Color.FromArgb(24, 26, 32);
            Controls.Add(_web);

            Shown += MainForm_Shown;
            FormClosing += MainForm_FormClosing;
            _web.CoreWebView2InitializationCompleted += Web_InitCompleted;

            Thread pump = new Thread(ActivationLoop);
            pump.IsBackground = true;
            pump.Name = "dsh-activate-wait";
            pump.Start();
        }

        private string UserDataFolder()
        {
            return Path.Combine(_root, "data", ".webview");
        }

        private void ActivationLoop()
        {
            while (!_closed)
            {
                if (_activate.WaitOne(400))
                {
                    if (_closed) return;
                    try { BeginInvoke(new Action(BringToFrontNow)); }
                    catch (Exception) { }
                }
            }
        }

        private void BringToFrontNow()
        {
            try
            {
                if (WindowState == FormWindowState.Minimized)
                {
                    WindowState = FormWindowState.Normal;
                }
                ShowWindow(Handle, SW_RESTORE);
                SetForegroundWindow(Handle);
                Activate();
            }
            catch (Exception) { }
        }

        private async void MainForm_Shown(object sender, EventArgs e)
        {
            string failure = null;
            try
            {
                await BootAsync();
            }
            catch (Exception ex)
            {
                Host.Log("boot failed: " + ex.GetType().Name + ": " + ex.Message);
                failure = ex.Message;
            }
            if (failure != null)
            {
                await ShowHtmlAsync(MessagePage("启动失败", "本地配置服务启动时出错：" + failure));
            }
        }

        private async Task BootAsync()
        {
            Directory.CreateDirectory(UserDataFolder());

            string nodeExe = Path.Combine(_root, "runtime", "node", "node.exe");
            string server = Path.Combine(_root, "tools", "ui-server.js");

            if (!File.Exists(nodeExe) || !File.Exists(server))
            {
                Host.Log("missing runtime: node=" + nodeExe + " exists=" + File.Exists(nodeExe)
                    + ", server exists=" + File.Exists(server));
                await ShowHtmlAsync(MessagePage("还没构建",
                    "没有找到 runtime\\node\\node.exe 或 tools\\ui-server.js。<br /><br />"
                    + "请先在启动盘根目录运行 <b>build.cmd</b> 完成构建，然后再双击这个启动器。<br /><br />"
                    + "（现在窗口里不会有配置页，也不会闪退。）"));
                return;
            }

            _port = Host.FindFreePort(3181);
            Host.Log("starting ui-server on 127.0.0.1:" + _port);
            StartServer(nodeExe, server, _port);

            if (_token == null)
            {
                Host.Log("ui-server printed no token within 30s");
                await ShowHtmlAsync(MessagePage("配置服务没起来",
                    "等了 30 秒也没拿到本地地址。请关掉窗口后重试，或直接运行 dsh-ui.cmd 排查。"));
                return;
            }
            Host.Log("token received (" + _token.Length + " chars)");
            // NOTE: only the length is logged above, never the token itself.

            bool ready = await WaitReadyAsync(_port, _token, 30000);
            if (!ready)
            {
                Host.Log("ui-server did not answer 200 within 30s");
                await ShowHtmlAsync(MessagePage("配置服务没响应",
                    "端口已打开但没有返回 200。请关掉窗口后重试。"));
                return;
            }
            Host.Log("ui-server ready");

            if (!await EnsureWebAsync())
            {
                return; // fallback already launched
            }

            string url = "http://127.0.0.1:" + _port.ToString(CultureInfo.InvariantCulture) + "/";
            _web.CoreWebView2.Navigate(url);
        }

        private void StartServer(string nodeExe, string server, int port)
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = nodeExe;
            // The token is minted by the server itself; nothing secret is on this
            // command line.
            psi.Arguments = Host.Quote(server) + " --no-open --port "
                + port.ToString(CultureInfo.InvariantCulture);
            psi.WorkingDirectory = _root;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            // 把自己的 pid 交给服务：启动器被强杀（任务管理器 / taskkill /F）时，
            // ui-server 会在几秒内自己退出，不留孤儿服务。dsh 是独立子进程，
            // 不跟着死——和「关窗时选择后台继续」的语义一致。
            psi.EnvironmentVariables["DSH_LAUNCHER_PID"] =
                Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture);

            Process node = new Process();
            node.StartInfo = psi;
            node.EnableRaisingEvents = true;
            node.Exited += Node_Exited;

            try
            {
                node.Start();
            }
            catch (Exception ex)
            {
                Host.Log("cannot start node: " + ex.Message);
                return;
            }

            _node = node;
            _nodeStarted = true;

            ManualResetEventSlim got = new ManualResetEventSlim(false);
            StringBuilder buffer = new StringBuilder();

            node.OutputDataReceived += delegate(object s, DataReceivedEventArgs e)
            {
                if (e.Data == null) return;
                // stdout carries the token: it is parsed, never logged.
                lock (buffer)
                {
                    buffer.AppendLine(e.Data);
                    Match m = Host.TokenPattern.Match(buffer.ToString());
                    if (m.Success)
                    {
                        _token = m.Groups[1].Value;
                        got.Set();
                    }
                }
            };
            // Host.Log sanitizes, so a token in stderr cannot leak either.
            node.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e)
            {
                if (e.Data != null) Host.Log("ui-server stderr: " + e.Data);
            };

            node.BeginOutputReadLine();
            node.BeginErrorReadLine();
            got.Wait(30000);
        }

        private void Node_Exited(object sender, EventArgs e)
        {
            int code = -1;
            try { code = ((Process)sender).ExitCode; }
            catch (Exception) { }
            Host.Log("ui-server exited with code " + code);
        }

        private static async Task<bool> WaitReadyAsync(int port, string token, int timeoutMs)
        {
            using (HttpClient client = new HttpClient())
            {
                client.Timeout = TimeSpan.FromSeconds(5);
                client.DefaultRequestHeaders.Add("x-config-token", token);
                string url = "http://127.0.0.1:" + port.ToString(CultureInfo.InvariantCulture) + "/";
                Stopwatch sw = Stopwatch.StartNew();
                while (sw.ElapsedMilliseconds < timeoutMs)
                {
                    try
                    {
                        using (HttpResponseMessage resp = await client.GetAsync(url))
                        {
                            if ((int)resp.StatusCode == 200) return true;
                        }
                    }
                    catch (Exception) { }
                    await Task.Delay(300);
                }
                return false;
            }
        }

        private async Task<bool> EnsureWebAsync()
        {
            if (_webReady) return true;
            try
            {
                if (_web.CreationProperties == null)
                {
                    _web.CreationProperties = new CoreWebView2CreationProperties();
                }
                // Must be set BEFORE EnsureCoreWebView2Async.
                _web.CreationProperties.UserDataFolder = UserDataFolder();

                // Deliberately no CoreWebView2Environment.CreateAsync here: it
                // throws E_NOINTERFACE against the installed runtime.  Passing
                // null uses the default environment.
                await _web.EnsureCoreWebView2Async(null);

                ApplySettings(_web.CoreWebView2.Settings);
                _web.CoreWebView2.WebMessageReceived += Web_MessageReceived;
                _web.CoreWebView2.NavigationStarting += Web_NavigationStarting;
                _web.CoreWebView2.NavigationCompleted += Web_NavigationCompleted;

                // ui-server.js currently rejects even "/" without a token.  The
                // contract forbids putting it in the URL, so it rides along as a
                // request header on our own origin only (never on third-party
                // requests, so it cannot leak off-box).
                if (_port > 0)
                {
                    _web.CoreWebView2.AddWebResourceRequestedFilter(
                        "http://127.0.0.1:" + _port.ToString(CultureInfo.InvariantCulture) + "/*",
                        CoreWebView2WebResourceContext.All);
                    _web.CoreWebView2.WebResourceRequested += Web_ResourceRequested;
                }

                _webReady = true;
                Host.Log("webview2 ready");
                return true;
            }
            catch (Exception ex)
            {
                Host.Log("webview2 init failed: " + ex.GetType().Name + ": " + ex.Message);
                FallbackToCmd();
                return false;
            }
        }

        private void Web_InitCompleted(object sender, CoreWebView2InitializationCompletedEventArgs e)
        {
            if (e.IsSuccess)
            {
                try { ApplySettings(_web.CoreWebView2.Settings); }
                catch (Exception) { }
                return;
            }
            Host.Log("webview2 initialization completed with failure: "
                + (e.InitializationException == null ? "unknown" : e.InitializationException.Message));
            FallbackToCmd();
        }

        private static void ApplySettings(CoreWebView2Settings s)
        {
            s.AreDevToolsEnabled = false;
            s.AreDefaultContextMenusEnabled = false;
            s.AreBrowserAcceleratorKeysEnabled = false;
            s.IsPasswordAutosaveEnabled = false;
            s.IsGeneralAutofillEnabled = false;
            s.AreDefaultScriptDialogsEnabled = false;
            s.IsStatusBarEnabled = false;
            s.AreHostObjectsAllowed = false;
        }

        private void Web_NavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            string uri = e.Uri == null ? string.Empty : e.Uri;
            if (uri.StartsWith("about:", StringComparison.OrdinalIgnoreCase)
                || uri.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
            {
                return; // NavigateToString() uses about:blank
            }
            string allowed = "http://127.0.0.1:" + _port.ToString(CultureInfo.InvariantCulture);
            if (!uri.StartsWith(allowed, StringComparison.OrdinalIgnoreCase))
            {
                e.Cancel = true;
                Host.Log("navigation blocked: " + uri);
            }
        }

        private async void Web_NavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (e.IsSuccess) Host.Log("page loaded");
            else Host.Log("page load failed: " + e.WebErrorStatus);

            if (_probeDone) return;
            _probeDone = true;

            // Opt-in self test (DSH_LAUNCHER_SELFTEST=1): drives the real
            // WebMessageReceived -> PostWebMessageAsJson path and logs only the
            // message type and token *length*, never the token.
            if (Environment.GetEnvironmentVariable("DSH_LAUNCHER_SELFTEST") != "1") return;
            if (!_webReady) return;
            try
            {
                await _web.CoreWebView2.ExecuteScriptAsync(
                    "window.__dshProbe=null;"
                    + "window.chrome.webview.addEventListener('message',function(ev){window.__dshProbe=ev.data;});"
                    + "window.chrome.webview.postMessage({type:'dsh.token.request'});'sent'");
                await Task.Delay(600);
                string res = await _web.CoreWebView2.ExecuteScriptAsync(
                    "(function(){var p=window.__dshProbe;if(!p)return 'no-reply';"
                    + "return String(p.type)+' token-length='+String(p.token?p.token.length:0);})()");
                string dom = await _web.CoreWebView2.ExecuteScriptAsync(
                    "(function(){return 'title='+String(document.title)+' text-length='+"
                    + "String((document.body&&document.body.innerText||'').length);})()");
                Host.Log("selftest bridge: " + res + " | page " + dom);
            }
            catch (Exception ex)
            {
                Host.Log("selftest failed: " + ex.Message);
            }
        }

        private void Web_ResourceRequested(object sender, CoreWebView2WebResourceRequestedEventArgs e)
        {
            // Same-origin only: the filter above is narrow, and we double-check
            // the URI so the token can never be sent to anything but our server.
            if (_token == null || _port <= 0) return;
            string uri;
            try { uri = e.Request.Uri; }
            catch (Exception) { return; }
            string allowed = "http://127.0.0.1:" + _port.ToString(CultureInfo.InvariantCulture) + "/";
            if (uri == null || !uri.StartsWith(allowed, StringComparison.OrdinalIgnoreCase)) return;
            try
            {
                e.Request.Headers.SetHeader("x-config-token", _token);
            }
            catch (Exception) { }
        }

        private void Web_MessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string json;
            try { json = e.WebMessageAsJson; }
            catch (Exception) { return; }
            if (string.IsNullOrEmpty(json)) return;

            if (json.IndexOf("\"dsh.token.request\"", StringComparison.Ordinal) >= 0)
            {
                PostToken();
                return;
            }
            if (json.IndexOf("\"dsh.activate\"", StringComparison.Ordinal) >= 0)
            {
                BringToFrontNow();
            }
        }

        private void PostToken()
        {
            if (_token == null || !_webReady) return;
            try
            {
                // base64url only, so no escaping is required.
                string payload = "{\"type\":\"dsh.token\",\"token\":\"" + _token + "\"}";
                _web.CoreWebView2.PostWebMessageAsJson(payload);
            }
            catch (Exception ex)
            {
                Host.Log("post token failed: " + ex.Message);
            }
        }

        private async Task ShowHtmlAsync(string html)
        {
            if (!await EnsureWebAsync()) return;   // fallback already launched
            _web.CoreWebView2.NavigateToString(html);
        }

        private void FallbackToCmd()
        {
            if (_fallbackDone) return;
            _fallbackDone = true;
            Host.Log("falling back to dsh-ui.cmd");
            try
            {
                BeginInvoke(new Action(delegate
                {
                    try { Close(); }
                    catch (Exception) { }
                    try
                    {
                        string cmd = Path.Combine(_root, "dsh-ui.cmd");
                        ProcessStartInfo psi = new ProcessStartInfo(cmd);
                        psi.UseShellExecute = true;
                        psi.WorkingDirectory = _root;
                        Process.Start(psi);
                    }
                    catch (Exception ex)
                    {
                        Host.Log("fallback start failed: " + ex.Message);
                    }
                }));
            }
            catch (Exception) { }
        }

        private static string MessagePage(string heading, string body)
        {
            return "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\" />"
                + "<title>dsh-to-go</title><style>"
                + "html,body{margin:0;height:100%;background:#181a20;color:#e7e9ee;"
                + "font-family:'Segoe UI','Microsoft YaHei',sans-serif;}"
                + ".box{max-width:640px;margin:0 auto;padding:72px 32px;line-height:1.75;}"
                + "h1{font-size:20px;font-weight:600;margin:0 0 18px;}"
                + "p{font-size:14px;color:#b9bfcc;margin:0 0 14px;}"
                + "code{background:#22252e;padding:2px 6px;border-radius:4px;color:#9ad1ff;}"
                + "</style></head><body><div class=\"box\"><h1>" + heading + "</h1><p>"
                + body + "</p></div></body></html>";
        }

        private bool _closeConfirmed;
        private bool _closeFlowRunning;

        private void MainForm_FormClosing(object sender, FormClosingEventArgs e)
        {
            // 关窗要先问一次「dsh 要不要一起停」：不能在这里同步阻塞 UI 线程，
            // 所以先取消这次关闭，走完流程再真正关。
            if (!_closeConfirmed)
            {
                e.Cancel = true;
                BeginCloseFlow();
                return;
            }
            CleanupServer();
        }

        private void CleanupServer()
        {
            _closed = true;
            try { _activate.Set(); }
            catch (Exception) { }

            if (_nodeStarted && _node != null)
            {
                try
                {
                    if (!_node.HasExited)
                    {
                        int pid = _node.Id;
                        ProcessStartInfo psi = new ProcessStartInfo("taskkill",
                            "/F /T /PID " + pid.ToString(CultureInfo.InvariantCulture));
                        psi.UseShellExecute = false;
                        psi.CreateNoWindow = true;
                        psi.WindowStyle = ProcessWindowStyle.Hidden;
                        using (Process kill = Process.Start(psi))
                        {
                            if (kill != null) kill.WaitForExit(5000);
                        }
                        Host.Log("ui-server stopped (own pid " + pid + ")");
                    }
                }
                catch (Exception ex)
                {
                    Host.Log("taskkill failed: " + ex.Message);
                }
            }
        }

        // ---------------------------------------------------------------- 关窗语义
        // 已解锁 + dsh 在跑 → 问一次「要不要一起停」（默认停）；
        // 未解锁 → 停不了（/api/dsh/stop 需要口令），如实告知并只关窗口。
        private async void BeginCloseFlow()
        {
            if (_closeFlowRunning) return;
            _closeFlowRunning = true;
            try
            {
                bool running = false;
                try { running = await DshRunningAsync(); }
                catch (Exception ex) { Host.Log("close: 状态查询失败: " + ex.Message); }

                if (running)
                {
                    bool? keep = AskCloseChoice();
                    if (keep == null) return;            // 取消：什么都不做
                    if (keep == false)
                    {
                        string err = await StopDshAsync();
                        if (err != null)
                        {
                            Host.Log("close: 停 dsh 失败: " + err);
                            MessageBox.Show(this,
                                "没能停掉 dsh：" + err + "\r\n\r\ndsh 会继续在后台运行；下次打开启动器还能看到它的状态。",
                                "dsh 仍在运行", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                        }
                        else Host.Log("close: dsh 已停止");
                    }
                    else Host.Log("close: 用户选择让 dsh 继续在后台运行");
                }
            }
            catch (Exception ex)
            {
                Host.Log("close flow failed: " + ex.Message);
            }
            finally
            {
                _closeFlowRunning = false;
            }
            _closeConfirmed = true;
            Close();
        }

        private async Task<bool> DshRunningAsync()
        {
            if (_port <= 0 || _token == null) return false;
            using (HttpClient c = new HttpClient())
            {
                c.Timeout = TimeSpan.FromSeconds(5);
                c.DefaultRequestHeaders.TryAddWithoutValidation("x-config-token", _token);
                string body = await c.GetStringAsync("http://127.0.0.1:"
                    + _port.ToString(CultureInfo.InvariantCulture) + "/api/state");
                Match m = Regex.Match(body, "\"dsh\"\\s*:\\s*\\{[\\s\\S]{0,600}?\"running\"\\s*:\\s*(true|false)");
                return m.Success && m.Groups[1].Value == "true";
            }
        }

        private async Task<string> StopDshAsync()
        {
            if (_port <= 0 || _token == null) return "没有本地服务地址";
            using (HttpClient c = new HttpClient())
            {
                c.Timeout = TimeSpan.FromSeconds(25);
                c.DefaultRequestHeaders.TryAddWithoutValidation("x-config-token", _token);
                HttpResponseMessage r = await c.PostAsync(
                    "http://127.0.0.1:" + _port.ToString(CultureInfo.InvariantCulture) + "/api/dsh/stop",
                    new StringContent("{}", Encoding.UTF8, "application/json"));
                string body = await r.Content.ReadAsStringAsync();
                if ((int)r.StatusCode == 200) return null;
                if ((int)r.StatusCode == 401) return "需要先在配置页里输入口令解锁（口令只在页面里输入，启动器不保存）";
                Match m = Regex.Match(body, "\"error\"\\s*:\\s*\"([^\"]*)\"");
                return m.Success ? m.Groups[1].Value : ("HTTP " + (int)r.StatusCode);
            }
        }

        /// <summary>返回 true=保持运行并关闭，false=停掉 dsh 并关闭，null=取消。</summary>
        private bool? AskCloseChoice()
        {
            using (Form dlg = new Form())
            {
                dlg.Text = "关闭启动器";
                dlg.FormBorderStyle = FormBorderStyle.FixedDialog;
                dlg.StartPosition = FormStartPosition.CenterParent;
                dlg.MinimizeBox = false;
                dlg.MaximizeBox = false;
                dlg.ShowInTaskbar = false;
                dlg.ClientSize = new Size(452, 196);
                dlg.BackColor = Color.FromArgb(41, 41, 41);
                dlg.ForeColor = Color.FromArgb(255, 255, 255);

                Label title = new Label();
                title.Text = "dsh 还在运行";
                title.Font = new Font("Segoe UI", 11F, FontStyle.Bold);
                title.AutoSize = true;
                title.Location = new Point(18, 16);
                dlg.Controls.Add(title);

                Label body = new Label();
                body.Text = "关掉启动器时，要不要连 dsh 一起停掉？（默认停掉，不留后台进程）";
                body.AutoSize = false;
                body.Size = new Size(416, 24);
                body.ForeColor = Color.FromArgb(214, 214, 214);
                body.Location = new Point(18, 48);
                dlg.Controls.Add(body);

                CheckBox keep = new CheckBox();
                keep.Text = "让 dsh 继续在后台运行（下次打开启动器还能看到它的状态）";
                keep.AutoSize = false;
                keep.Size = new Size(416, 40);
                keep.Location = new Point(18, 80);
                keep.Checked = false;
                dlg.Controls.Add(keep);

                Button close = new Button();
                close.Text = "关闭";
                close.Size = new Size(96, 32);
                close.Location = new Point(232, 140);
                close.DialogResult = DialogResult.OK;
                dlg.Controls.Add(close);

                Button cancel = new Button();
                cancel.Text = "取消";
                cancel.Size = new Size(96, 32);
                cancel.Location = new Point(338, 140);
                cancel.DialogResult = DialogResult.Cancel;
                dlg.Controls.Add(cancel);

                dlg.AcceptButton = close;
                dlg.CancelButton = cancel;

                DialogResult r = dlg.ShowDialog(this);
                if (r != DialogResult.OK) return null;
                return keep.Checked;
            }
        }
    }
}
