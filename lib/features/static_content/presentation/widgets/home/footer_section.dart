import 'package:flutter/material.dart';
import '../../../../../core/theme/app_theme.dart';

/// 页脚
class FooterSection extends StatelessWidget {
  const FooterSection({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: 40, horizontal: 24),
      color: AppTheme.inkBlack,
      child: Column(
        children: [
          Text(
            '© 2026 开源古籍项目组 (Kaiyuan Guji Project). All rights reserved.',
            style: TextStyle(
              color: Colors.white.withValues(alpha: 0.5),
              fontSize: 12,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            '基于 Apache-2.0 协议授权',
            style: TextStyle(
              color: Colors.white.withValues(alpha: 0.3),
              fontSize: 12,
            ),
          ),
        ],
      ),
    );
  }
}
