import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../features/static_content/presentation/pages/home_page.dart';
import '../../features/static_content/presentation/pages/reader_page.dart';
import '../../features/book_index/presentation/pages/book_index_page.dart';
import '../../features/book_index/presentation/pages/book_detail_page.dart';

/// 应用路由配置
class AppRouter {
  // 禁止实例化
  AppRouter._();

  /// 路由路径常量
  static const String home = '/';
  static const String assistant = '/assistant';
  static const String roadmap = '/roadmap';
  static const String reader = '/read';
  static const String bookIndex = '/book-index';

  /// 创建带标题的页面
  static Page<void> _buildPage(Widget child, String title) {
    return MaterialPage(
      child: Title(
        title: title,
        color: const Color(0xFF8B0000),
        child: child,
      ),
    );
  }

  /// 创建路由配置
  static GoRouter createRouter() {
    return GoRouter(
      initialLocation: home,
      routes: [
        // 首页
        GoRoute(
          path: home,
          name: 'home',
          pageBuilder: (context, state) => _buildPage(
            const HomePage(),
            '首页',
          ),
        ),

        // 古籍助手
        GoRoute(
          path: assistant,
          name: 'assistant',
          pageBuilder: (context, state) => _buildPage(
            const ReaderPage(filename: 'assistant'),
            '古籍助手',
          ),
        ),

        // 路线图
        GoRoute(
          path: roadmap,
          name: 'roadmap',
          pageBuilder: (context, state) => _buildPage(
            const ReaderPage(filename: 'roadmap_overview'),
            '路线图',
          ),
        ),

        // 阅读页面（带参数）
        // 使用方式: /read?file=phase1
        GoRoute(
          path: reader,
          name: 'reader',
          pageBuilder: (context, state) {
            final filename = state.uri.queryParameters['file'];
            final useClassicStyle =
                state.uri.queryParameters['classic'] == 'true';

            if (filename == null || filename.isEmpty) {
              return _buildPage(
                const _ErrorPage(
                  message: '请指定要阅读的文件\n\n示例: /read?file=phase1',
                ),
                '错误',
              );
            }

            return _buildPage(
              ReaderPage(
                filename: filename,
                useClassicStyle: useClassicStyle,
              ),
              filename,
            );
          },
        ),

        // 古籍索引首页
        GoRoute(
          path: bookIndex,
          name: 'bookIndex',
          pageBuilder: (context, state) => _buildPage(
            const BookIndexPage(),
            '古籍索引',
          ),
        ),

        // 古籍详情页
        // 使用方式: /book-index/CX8nMA93gxX
        GoRoute(
          path: '$bookIndex/:id',
          name: 'bookDetail',
          pageBuilder: (context, state) {
            final id = state.pathParameters['id'];
            if (id == null || id.isEmpty) {
              return _buildPage(
                const _ErrorPage(message: '请指定古籍ID'),
                '错误',
              );
            }
            // 详情页标题会在页面加载后动态更新为书名
            return _buildPage(
              BookDetailPage(bookId: id),
              '古籍详情',
            );
          },
        ),
      ],

      // 错误页面
      errorPageBuilder: (context, state) {
        return _buildPage(
          _ErrorPage(message: '页面不存在\n\n路径: ${state.uri}'),
          '页面不存在',
        );
      },
    );
  }

  /// 导航到阅读页面
  static void goToReader(
    BuildContext context,
    String filename, {
    bool useClassicStyle = false,
  }) {
    final params = ['file=$filename', if (useClassicStyle) 'classic=true'];
    context.go('$reader?${params.join('&')}');
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
