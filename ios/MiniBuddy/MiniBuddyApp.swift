import SwiftUI
import UIKit

@main
struct MiniBuddyApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .preferredColorScheme(.dark)
        }
    }
}

struct ContentView: View {
    var body: some View {
        // 全屏铺满，HTML 自己用 env(safe-area-inset-*) 避让刘海与 Home 指示条
        WebView()
            .ignoresSafeArea()
    }
}

struct WebView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> WebViewController {
        WebViewController()
    }
    func updateUIViewController(_ uiViewController: WebViewController, context: Context) {}
}
