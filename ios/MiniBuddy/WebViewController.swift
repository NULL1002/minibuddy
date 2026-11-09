import UIKit
import WebKit

/// WKWebView 壳：
/// 1) 用自定义 scheme `buddy://` 把 bundle 内的 www/ 当站点根目录，获得稳定 origin；
/// 2) `mbFetch` 网络桥：由 Swift 发 HTTPS 请求，绕开浏览器 CORS，网页里也能直连任意 OpenAI 兼容接口；
/// 3) `mbStore` 存储桥：把数据快照同步写进 UserDefaults，启动时注入 __MB_BOOTSTRAP__，
///    即使自定义 scheme 下 localStorage 被系统禁用，数据也不会丢。
final class WebViewController: UIViewController, WKNavigationDelegate, WKScriptMessageHandler, WKURLSchemeHandler {

    private var webView: WKWebView?
    private let storeKey = "MiniBuddyStore"

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.043, green: 0.063, blue: 0.125, alpha: 1)

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(self, forURLScheme: "buddy")
        config.defaultWebpagePreferences.allowsContentJavaScript = true

        // 启动时注入上一次持久化的数据快照（documentStart，页面脚本执行前就绪）
        let raw = UserDefaults.standard.dictionary(forKey: storeKey) ?? [:]
        var restored: [String: Any] = [:]
        for (key, value) in raw {
            if let s = value as? String, let data = s.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: data, options: []) {
                restored[key] = obj
            }
        }
        var bootstrapJSON = "{}"
        if let data = try? JSONSerialization.data(withJSONObject: restored, options: []),
           let s = String(data: data, encoding: .utf8) { bootstrapJSON = s }
        config.userContentController.addUserScript(
            WKUserScript(source: "window.__MB_BOOTSTRAP__=\(bootstrapJSON);",
                         injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
        config.userContentController.add(self, name: "mbFetch")
        config.userContentController.add(self, name: "mbStore")

        let wv = WKWebView(frame: .zero, configuration: config)
        wv.translatesAutoresizingMaskIntoConstraints = false
        wv.navigationDelegate = self
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        wv.isOpaque = false
        wv.backgroundColor = .clear
        wv.scrollView.backgroundColor = .clear
        view.addSubview(wv)
        NSLayoutConstraint.activate([
            wv.topAnchor.constraint(equalTo: view.topAnchor),
            wv.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            wv.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            wv.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
        webView = wv

        wv.load(URLRequest(url: URL(string: "buddy://app/index.html")!))
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    // MARK: - 站点根目录

    private var webRoot: URL {
        let direct = Bundle.main.bundleURL.appendingPathComponent("www")
        if FileManager.default.fileExists(atPath: direct.appendingPathComponent("index.html").path) {
            return direct
        }
        if let u = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "www") {
            return u.deletingLastPathComponent()
        }
        return Bundle.main.bundleURL
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else { return }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let file = webRoot.appendingPathComponent(String(path.dropFirst()))
        guard let data = try? Data(contentsOf: file),
              let response = HTTPURLResponse(
                url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                headerFields: [
                    "Content-Type": mime(for: path),
                    "Cache-Control": "no-cache",
                    "Access-Control-Allow-Origin": "*"
                ]) else {
            urlSchemeTask.didFailWithError(NSError(
                domain: "MiniBuddy", code: 404,
                userInfo: [NSLocalizedDescriptionKey: "找不到资源 \(path)"]))
            return
        }
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    private func mime(for path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "js": return "application/javascript; charset=utf-8"
        case "json", "webmanifest": return "application/manifest+json; charset=utf-8"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "svg": return "image/svg+xml"
        default: return "application/octet-stream"
        }
    }

    // MARK: - JS → 原生消息

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        if message.name == "mbStore" {
            guard let key = body["key"] as? String,
                  let value = body["value"],
                  let data = try? JSONSerialization.data(withJSONObject: value, options: []),
                  let json = String(data: data, encoding: .utf8) else { return }
            var store = UserDefaults.standard.dictionary(forKey: storeKey) ?? [:]
            store[key] = json
            UserDefaults.standard.set(store, forKey: storeKey)
            return
        }
        if message.name == "mbFetch" { handleFetch(body) }
    }

    private func handleFetch(_ body: [String: Any]) {
        guard let id = body["id"] as? Int,
              let urlString = body["url"] as? String,
              let url = URL(string: urlString),
              let headers = body["headers"] as? [String: String],
              let payload = body["body"] as? [String: Any],
              let httpBody = try? JSONSerialization.data(withJSONObject: payload, options: []) else { return }

        var request = URLRequest(url: url, timeoutInterval: 60)
        request.httpMethod = "POST"
        request.httpBody = httpBody
        for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                if let error = error {
                    self?.reply(id: id, ok: false, payload: error.localizedDescription)
                    return
                }
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                let text = String(data: data ?? Data(), encoding: .utf8) ?? ""
                if status < 200 || status >= 300 {
                    self?.reply(id: id, ok: false, payload: "HTTP \(status) " + String(text.prefix(300)))
                    return
                }
                self?.reply(id: id, ok: true, payload: text)
            }
        }.resume()
    }

    private func reply(id: Int, ok: Bool, payload: String) {
        // JSONEncoder 对 String 产出带引号的合法 JS 字符串字面量，避免拼接注入问题
        let encoded: String
        if let data = try? JSONEncoder().encode(payload), let s = String(data: data, encoding: .utf8) {
            encoded = s
        } else { encoded = "\"\"" }
        let js = "window.__mbNativeCallback(\(id), \(ok ? "true" : "false"), \(encoded));"
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }

    // MARK: - 外链交给系统浏览器

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url,
           let scheme = url.scheme?.lowercased(),
           scheme == "http" || scheme == "https",
           navigationAction.targetFrame?.isMainFrame == true {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }
}
