import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../features/static_content/presentation/pages/home_page.dart';
import '../../features/static_content/presentation/pages/reader_page.dart';

/// 应用路由配置
class AppRouter {
  // 禁止实例化
  AppRouter._();

  /// 路由路径常量
  static const String home = '/';
  static const String assistant = '/assistant';
  static const String roadmap = '/roadmap';
  static const String reader = '/read';

  /// 创建路由配置
  static GoRouter createRouter() {
    return GoRouter(
      initialLocation: home,
      routes: [
        // 首页
        GoRoute(
          path: home,
          name: 'home',
          builder: (context, state) => const HomePage(),
        ),

        // 古籍助手
        GoRoute(
          path: assistant,
          name: 'assistant',
          builder: (context, state) => const ReaderPage(filename: 'assistant'),
        ),

        // 路线图
        GoRoute(
          path: roadmap,
          name: 'roadmap',
          builder: (context, state) =>
              const ReaderPage(filename: 'roadmap_overview'),
        ),

        // 阅读页面（带参数）
        // 使用方式: /read?file=phase1
        GoRoute(
          path: reader,
          name: 'reader',
          builder: (context, state) {
            final filename = state.uri.queryParameters['file'];
            final useClassicStyle =
                state.uri.queryParameters['classic'] == 'true';

            if (filename == null || filename.isEmpty) {
              return const _ErrorPage(
                message: '请指定要阅读的文件\n\n示例: /read?file=phase1',
              );
            }

            return ReaderPage(
              filename: filename,
              useClassicStyle: useClassicStyle,
            );
          },
        ),

      ],

      // 错误页面
      errorBuilder: (context, state) {
        return _ErrorPage(message: '页面不存在\n\n路径: ${state.uri}');
      },
    );
  }

  /// 导航到阅读页面
  static void goToReader(
    BuildContext context,
    String filename, {
    bool useClassicStyle = false,
  }) {
    context.go(
      '$reader?file=$filename${useClassicStyle ? '&classic=true' : ''}',
    );
  }

  /// 导航到首页
  static void goToHome(BuildContext context) {
    context.go(home);
  }
}

/// 错误页面组件
class _ErrorPage extends StatelessWidget {
  final String message;

  const _ErrorPage({required this.message});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('错误')),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(
                Icons.error_outline,
                size: 64,
                color: Color(0xFF8B0000),
              ),
              const SizedBox(height: 24),
              Text(
                message,
                style: Theme.of(context).textTheme.bodyLarge,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 32),
              ElevatedButton(
                onPressed: () => AppRouter.goToHome(context),
                child: const Text('返回首页'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
