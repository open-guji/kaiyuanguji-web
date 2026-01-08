import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../../../../core/theme/app_theme.dart';
import 'section_header.dart';

/// 古籍助手导向板块
class AssistantSection extends StatelessWidget {
  const AssistantSection({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: 48, horizontal: 24),
      color: const Color(0xFFF7F9F9), // Light cool gray to distinguish
      child: Column(
        children: [
          SectionHeader(
            title: '古籍助手',
            subtitle: '基于大模型的智能科研辅助工具',
            onTap: () => context.go('/assistant'),
          ),
          const SizedBox(height: 32),
          Container(
            constraints: const BoxConstraints(maxWidth: 900),
            padding: const EdgeInsets.all(32),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(
                color: AppTheme.borderColor.withValues(alpha: 0.5),
              ),
              boxShadow: [
                BoxShadow(
                  color: AppTheme.inkBlack.withValues(alpha: 0.03),
                  blurRadius: 30,
                  offset: const Offset(0, 10),
                ),
              ],
            ),
            child: Row(
              children: [
                const Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '核心集成 · 全端协同 · 开放源码',
                        style: TextStyle(
                          color: AppTheme.vermilionRed,
                          fontWeight: FontWeight.bold,
                          letterSpacing: 1.2,
                        ),
                      ),
                      SizedBox(height: 16),
                      Text(
                        '古籍助手是本项目所有技术成果的统一集成门户。它深度整合了 OCR 识别、校对工具及 AI 分析等一系列核心能力，提供 Web 与桌面端多端支持，致力于构建人人可用的开源数字人文环境。',
                        style: TextStyle(
                          color: AppTheme.inkBlack,
                          fontSize: 18,
                          height: 1.6,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 40),
                ElevatedButton(
                  onPressed: () async {
                    final uri = Uri.parse('https://toolkit.kaiyuanguji.com/');
                    if (await canLaunchUrl(uri)) {
                      await launchUrl(uri, mode: LaunchMode.externalApplication);
                    }
                  },
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppTheme.inkBlack,
                    foregroundColor: Colors.white,
                    padding: const EdgeInsets.symmetric(
                      horizontal: 32,
                      vertical: 20,
                    ),
                    elevation: 0,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(8),
                    ),
                  ),
                  child: const Text('立即使用'),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
