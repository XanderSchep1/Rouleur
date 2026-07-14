import Cocoa
import WebKit
import Network

// Rouleur — a minimal native macOS shell that hosts the web app in a WKWebView.
//
// The app is served from a tiny embedded HTTP server on 127.0.0.1 rather than
// loaded as a file:// URL. WKWebView treats file:// pages as a restricted
// origin that can't fetch() cross-origin HTTPS APIs (BRouter/Overpass/
// Nominatim/Open-Meteo) even though those services allow it via CORS — the
// same code works fine from a real http:// origin, which is what this
// loopback server provides.
final class LocalServer {
    private var listener: NWListener?
    private let root: URL

    init(root: URL) { self.root = root }

    func start(completion: @escaping (UInt16?) -> Void) {
        do {
            let params = NWParameters.tcp
            params.allowLocalEndpointReuse = true
            let listener = try NWListener(using: params, on: .any)
            self.listener = listener
            listener.newConnectionHandler = { [weak self] conn in
                self?.handle(conn)
            }
            listener.stateUpdateHandler = { state in
                if case .ready = state, let port = listener.port {
                    completion(port.rawValue)
                } else if case .failed = state {
                    completion(nil)
                }
            }
            listener.start(queue: .main)
        } catch {
            completion(nil)
        }
    }

    private func handle(_ conn: NWConnection) {
        conn.start(queue: .main)
        receiveRequest(conn, buffer: Data())
    }

    private func receiveRequest(_ conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self = self else { return }
            var buf = buffer
            if let data = data, !data.isEmpty { buf.append(data) }
            // We only need the request line; stop once we have a full header block or hit EOF.
            if let text = String(data: buf, encoding: .utf8), text.contains("\r\n") || isComplete {
                self.respond(conn, requestHead: text)
            } else if error != nil || isComplete {
                conn.cancel()
            } else {
                self.receiveRequest(conn, buffer: buf)
            }
        }
    }

    private func respond(_ conn: NWConnection, requestHead: String) {
        let firstLine = requestHead.split(separator: "\r\n").first.map(String.init) ?? ""
        let parts = firstLine.split(separator: " ")
        var path = parts.count > 1 ? String(parts[1]) : "/"
        if let q = path.firstIndex(of: "?") { path = String(path[path.startIndex..<q]) }
        path = path.removingPercentEncoding ?? path
        if path == "/" { path = "/index.html" }
        // Prevent escaping the web root.
        let safeComponents = path.split(separator: "/").filter { $0 != ".." && $0 != "." }
        let fileURL = safeComponents.reduce(root) { $0.appendingPathComponent(String($1)) }

        if let data = try? Data(contentsOf: fileURL) {
            let ctype = contentType(for: fileURL.pathExtension)
            let header = "HTTP/1.1 200 OK\r\nContent-Type: \(ctype)\r\nContent-Length: \(data.count)\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
            var payload = Data(header.utf8)
            payload.append(data)
            conn.send(content: payload, completion: .contentProcessed { _ in conn.cancel() })
        } else {
            let body = "404 Not Found"
            let header = "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n"
            conn.send(content: Data((header + body).utf8), completion: .contentProcessed { _ in conn.cancel() })
        }
    }

    private func contentType(for ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "js": return "application/javascript; charset=utf-8"
        case "png": return "image/png"
        case "ico": return "image/x-icon"
        case "svg": return "image/svg+xml"
        case "json": return "application/json"
        default: return "application/octet-stream"
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var server: LocalServer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // persist localStorage (saved routes, prefs)

        let frame = NSRect(x: 0, y: 0, width: 1200, height: 820)
        webView = WKWebView(frame: frame, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.autoresizingMask = [.width, .height]
        if #available(macOS 13.3, *) { webView.isInspectable = true }

        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "Rouleur"
        window.contentMinSize = NSSize(width: 720, height: 560)
        window.center()
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        guard let resourceURL = Bundle.main.resourceURL else {
            loadErrorPage("Couldn't locate app resources.")
            return
        }
        let webRoot = resourceURL.appendingPathComponent("web")
        guard FileManager.default.fileExists(atPath: webRoot.appendingPathComponent("index.html").path) else {
            loadErrorPage("Couldn't find the bundled web app at \(webRoot.path).")
            return
        }
        let server = LocalServer(root: webRoot)
        self.server = server
        server.start { [weak self] port in
            guard let self = self else { return }
            DispatchQueue.main.async {
                guard let port = port, let url = URL(string: "http://127.0.0.1:\(port)/index.html") else {
                    self.loadErrorPage("Couldn't start the local server.")
                    return
                }
                self.webView.load(URLRequest(url: url))
            }
        }
    }

    private func loadErrorPage(_ message: String) {
        webView.loadHTMLString("<h2 style='font-family:sans-serif;padding:2rem'>\(message)</h2>", baseURL: nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // Open external target=_blank links (BRouter/OSM credits) in the default browser.
    func webView(_ webView: WKWebView, createWebViewWith config: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)

// Minimal menu so ⌘Q / ⌘W / copy-paste work.
let mainMenu = NSMenu()
let appMenuItem = NSMenuItem()
mainMenu.addItem(appMenuItem)
let appMenu = NSMenu()
appMenu.addItem(withTitle: "Hide Rouleur", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
appMenu.addItem(NSMenuItem.separator())
appMenu.addItem(withTitle: "Quit Rouleur", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
appMenuItem.submenu = appMenu
let editMenuItem = NSMenuItem()
mainMenu.addItem(editMenuItem)
let editMenu = NSMenu(title: "Edit")
editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
editMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
editMenuItem.submenu = editMenu
app.mainMenu = mainMenu

app.run()
