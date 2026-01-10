import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../theme/app_theme.dart';

/// 统一的页面布局框架
/// 提供响应式导航栏和页面结构
class LayoutShell extends StatelessWidget {
  /// 页面主体内容
  final Widget child;

  /// 当前页面标题（可选）
  final String? title;

  /// 是否显示返回按钮
  final bool showBackButton;

  /// 点击导航项的回调（用于在首页时滚动）
  final VoidCallback? onRoadmapTap;
  final VoidCallback? onAssistantTap;
  final VoidCallback? onJoinTap;

  const LayoutShell({
    super.key,
    required this.child,
    this.title,
    this.showBackButton = false,
    this.onRoadmapTap,
    this.onAssistantTap,
    this.onJoinTap,
  });

  @override
  Widget build(BuildContext context) {
    // 判断是否为移动端
    final isMobile = MediaQuery.of(context).size.width < 600;

    return Scaffold(
      backgroundColor: AppTheme.paperBackground,
      appBar: _buildAppBar(context, isMobile),
      drawer: isMobile ? _buildDrawer(context) : null,
      body: SelectionArea(child: child),
    );
  }

  /// 构建顶部导航栏
  PreferredSizeWidget _buildAppBar(BuildContext context, bool isMobile) {
    return AppBar(
      backgroundColor: AppTheme.paperBackground,
      elevation: 0,
      scrolledUnderElevation: 0, // 滚动时不改变阴影
      surfaceTintColor: Colors.transparent, // 滚动时不改变颜色
      centerTitle: false,
      leading: showBackButton
          ? IconButton(
              icon: const Icon(Icons.arrow_back),
              onPressed: () => context.pop(),
            )
          : null,
      title: isMobile ? _buildLogoText(context) : _buildLogoText(context),
      actions: isMobile ? null : _buildDesktopActions(context),
      bottom: PreferredSize(
        preferredSize: const Size.fromHeight(1),
        child: Container(height: 1, color: AppTheme.borderColor),
      ),
    );
  }

  /// Logo组件（图片+文字，用于AppBar title）
  Widget _buildLogoText(BuildContext context) {
    return GestureDetector(
      onTap: () => context.go('/'),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Image.asset(
            'assets/images/open-guji-logo.png',
            height: 32,
            fit: BoxFit.contain,
          ),
          const SizedBox(width: 8),
          Text(
            '开源古籍',
            style: Theme.of(context).textTheme.headlineMedium?.copyWith(
              color: AppTheme.inkBlack,
              fontWeight: FontWeight.bold,
              letterSpacing: 2.0,
            ),
          ),
        ],
      ),
    );
  }

  /// 桌面端导航按钮
  List<Widget> _buildDesktopActions(BuildContext context) {
    return [
      _buildNavButton(context, '首页', '/'),
      _buildNavButton(context, '路线图', '/roadmap', onTap: onRoadmapTap),
      _buildNavButton(context, '古籍助手', '/assistant', onTap: onAssistantTap),
      _buildNavButton(context, '参与开发', '#join', onTap: onJoinTap),
      const SizedBox(width: 16),
    ];
  }

  /// 单个导航按钮
  Widget _buildNavButton(
    BuildContext context,
    String label,
    String route, {
    VoidCallback? onTap,
  }) {
    final currentRoute = GoRouterState.of(context).uri.toString();
    final isActive =
        currentRoute == route ||
        (route != '/' && currentRoute.startsWith(route));

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 4),
      child: TextButton(
        onPressed: () {
          if (route.startsWith('#')) {
            // 如果是锚点，跳回首页并尝试滚动
            context.go('/');
            if (onTap != null) {
              // 延迟执行滚动，等待页面加载
              Future.delayed(const Duration(milliseconds: 300), onTap);
            }
          } else {
            // 直接跳转到对应页面
            context.go(route);
          }
        },
        style: TextButton.styleFrom(
          foregroundColor: isActive ? AppTheme.vermilionRed : AppTheme.inkBlack,
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 14,
            fontWeight: isActive ? FontWeight.bold : FontWeight.normal,
            letterSpacing: 1.0,
          ),
        ),
      ),
    );
  }

  /// 移动端抽屉菜单
  Widget _buildDrawer(BuildContext context) {
    return Drawer(
      backgroundColor: AppTheme.paperBackground,
      child: SafeArea(
        child: Column(
          children: [
            // 抽屉头部
            Container(
              padding: const EdgeInsets.all(24),
              decoration: BoxDecoration(
                border: Border(
                  bottom: BorderSide(color: AppTheme.borderColor, width: 1),
                ),
              ),
              child: Row(
                children: [
                  Image.asset(
                    'assets/images/open-guji-logo.png',
                    height: 32,
                    fit: BoxFit.contain,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      '开源古籍',
                      style: Theme.of(context).textTheme.headlineMedium
                          ?.copyWith(
                            fontWeight: FontWeight.bold,
                            letterSpacing: 2.0,
                          ),
                    ),
                  ),
                ],
              ),
            ),

            // 导航菜单
            Expanded(
              child: ListView(
                padding: const EdgeInsets.symmetric(vertical: 8),
                children: [
                  _buildDrawerItem(context, Icons.home, '首页', '/'),
                  _buildDrawerItem(
                    context,
                    Icons.map,
                    '路线图',
                    '/roadmap',
                    onTap: onRoadmapTap,
                  ),
                  _buildDrawerItem(
                    context,
                    Icons.auto_awesome,
                    '古籍助手',
                    '/assistant',
                    onTap: onAssistantTap,
                  ),
                  _buildDrawerItem(
                    context,
                    Icons.construction,
                    '参与开发',
                    '#join',
                    onTap: onJoinTap,
                  ),
                ],
              ),
            ),

            // 底部信息
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                border: Border(
                  top: BorderSide(color: AppTheme.borderColor, width: 1),
                ),
              ),
              child: Text(
                '开源古籍项目\n让古籍数字化更简单',
                textAlign: TextAlign.center,
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(height: 1.6),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 抽屉菜单项
  Widget _buildDrawerItem(
    BuildContext context,
    IconData icon,
    String label,
    String route, {
    VoidCallback? onTap,
  }) {
    final currentRoute = GoRouterState.of(context).uri.toString();
    final isActive =
        currentRoute == route ||
        (route != '/' && currentRoute.startsWith(route));

    return ListTile(
      leading: Icon(
        icon,
        color: isActive ? AppTheme.vermilionRed : AppTheme.inkBlack,
        size: 20,
      ),
      title: Text(
        label,
        style: TextStyle(
          color: isActive ? AppTheme.vermilionRed : AppTheme.inkBlack,
          fontWeight: isActive ? FontWeight.bold : FontWeight.normal,
          fontSize: 14,
          letterSpacing: 0.5,
        ),
      ),
      selected: isActive,
      selectedTileColor: AppTheme.vermilionRed.withValues(alpha: 0.05),
      onTap: () {
        Navigator.of(context).pop(); // 先关闭抽屉

        if (route.startsWith('#')) {
          // 如果是锚点，跳回首页并尝试滚动
          context.go('/');
          if (onTap != null) {
            // 延迟执行滚动，等待页面加载
            Future.delayed(const Duration(milliseconds: 300), onTap);
          }
        } else {
          // 直接跳转到对应页面
          context.go(route);
        }
      },
    );
  }

  /// 构建页脚 - 静态方法供其他页面复用
  static Widget buildFooter(BuildContext context) {
    final isMobile = MediaQuery.of(context).size.width < 600;
    return Container(
      decoration: BoxDecoration(
        color: AppTheme.paperBackground,
        border: Border(top: BorderSide(color: AppTheme.borderColor, width: 1)),
      ),
      padding: EdgeInsets.symmetric(
        horizontal: isMobile ? 16 : 32,
        vertical: isMobile ? 16 : 24,
      ),
      child: isMobile
          ? _buildMobileFooter(context)
          : _buildDesktopFooter(context),
    );
  }

  /// 桌面端页脚布局
  static Widget _buildDesktopFooter(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // 左侧：项目信息
        Expanded(
          flex: 2,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Image.asset(
                    'assets/images/open-guji-logo.png',
                    height: 24,
                    fit: BoxFit.contain,
                  ),
                  const SizedBox(width: 8),
                  Text(
                    '开源古籍',
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.bold,
                      letterSpacing: 1.5,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Text(
                '让古籍数字化更简单，让传统文化触手可及',
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: AppTheme.secondaryGray,
                  height: 1.6,
                ),
              ),
            ],
          ),
        ),

        // 中间：快速链接
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '快速链接',
                style: Theme.of(
                  context,
                ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.bold),
              ),
              const SizedBox(height: 8),
              _buildFooterLink(context, '项目源码', 'https://github.com/open-guji'),
              _buildFooterLink(
                context,
                '问题反馈',
                'https://github.com/open-guji/kaiyuanguji/issues',
              ),
            ],
          ),
        ),

        // 右侧：版权信息
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                '© ${DateTime.now().year} 开源古籍项目',
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(color: AppTheme.secondaryGray),
              ),
              const SizedBox(height: 4),
              Text(
                '基于 Flutter Web 构建',
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(color: AppTheme.secondaryGray),
              ),
            ],
          ),
        ),
      ],
    );
  }

  /// 移动端页脚布局
  static Widget _buildMobileFooter(BuildContext context) {
    return Column(
      children: [
        // 项目信息
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Image.asset(
              'assets/images/open-guji-logo.png',
              height: 20,
              fit: BoxFit.contain,
            ),
            const SizedBox(width: 6),
            Text(
              '开源古籍',
              style: Theme.of(context).textTheme.titleSmall?.copyWith(
                fontWeight: FontWeight.bold,
                letterSpacing: 1.0,
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        Text(
          '让古籍数字化更简单，让传统文化触手可及',
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
            color: AppTheme.secondaryGray,
            height: 1.6,
          ),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 12),

        // 快速链接
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            _buildFooterLink(context, '项目源码', 'https://github.com/open-guji'),
            const SizedBox(width: 16),
            _buildFooterLink(
              context,
              '问题反馈',
              'https://github.com/open-guji/kaiyuanguji/issues',
            ),
          ],
        ),
        const SizedBox(height: 12),

        // 版权信息
        Text(
          '© ${DateTime.now().year} 开源古籍项目',
          style: Theme.of(
            context,
          ).textTheme.bodySmall?.copyWith(color: AppTheme.secondaryGray),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 2),
        Text(
          '基于 Flutter Web 构建',
          style: Theme.of(
            context,
          ).textTheme.bodySmall?.copyWith(color: AppTheme.secondaryGray),
          textAlign: TextAlign.center,
        ),
      ],
    );
  }

  /// 页脚链接
  static Widget _buildFooterLink(
    BuildContext context,
    String label,
    String url,
  ) {
    return InkWell(
      onTap: () {
        // 显示外部链接提示
        final messenger = ScaffoldMessenger.maybeOf(context);
        if (messenger != null) {
          messenger.showSnackBar(
            SnackBar(
              content: Text('外部链接: $url'),
              duration: const Duration(seconds: 2),
            ),
          );
        }
      },
      child: Text(
        label,
        style: Theme.of(context).textTheme.bodySmall?.copyWith(
          color: AppTheme.vermilionRed,
          decoration: TextDecoration.underline,
        ),
      ),
    );
  }
}
