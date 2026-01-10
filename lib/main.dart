import 'package:flutter/material.dart';
import 'package:flutter_web_plugins/url_strategy.dart';
import 'core/router/app_router.dart';
import 'core/theme/app_theme.dart';

void main() {
  // 移除 URL 中的 # (Hash Strategy)
  usePathUrlStrategy();
  runApp(const KaiyuanGujiApp());
}

/// 开源古籍应用主入口
class KaiyuanGujiApp extends StatelessWidget {
  const KaiyuanGujiApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      title: '开源古籍',
      debugShowCheckedModeBanner: false,

      // 应用主题（古籍风格）
      theme: AppTheme.themeData,

      // 路由配置
      routerConfig: AppRouter.createRouter(),
    );
  }
}
