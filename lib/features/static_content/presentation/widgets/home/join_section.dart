import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../../../../core/theme/app_theme.dart';
import 'section_header.dart';

/// 参与开发区
class JoinSection extends StatelessWidget {
  const JoinSection({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: 48, horizontal: 24),
      decoration: BoxDecoration(
        color: AppTheme.paperBackground,
        border: Border(
          top: BorderSide(color: AppTheme.borderColor.withValues(alpha: 0.5)),
        ),
      ),
      child: Column(
        children: [
          const SectionHeader(title: '参与开发', subtitle: '汇聚技术力量，共同守护文化根脉'),
          const SizedBox(height: 32),
          Container(
            constraints: const BoxConstraints(maxWidth: 700),
            padding: const EdgeInsets.all(32),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(16),
              boxShadow: [
                BoxShadow(
                  color: AppTheme.inkBlack.withValues(alpha: 0.05),
                  blurRadius: 20,
                  offset: const Offset(0, 10),
                ),
              ],
            ),
            child: Column(
              children: [
                const Icon(
                  Icons.construction_rounded,
                  size: 64,
                  color: AppTheme.vermilionRed,
                ),
                const SizedBox(height: 24),
                Text(
                  '项目尚处起步阶段',
                  style: Theme.of(context).textTheme.headlineSmall,
                ),
                const SizedBox(height: 16),
                Text(
                  '我们正在密集构建核心框架与标准。具体的参与方式（包括代码贡献、数据校对及学术支持）将很快在此公布。\n\n感谢您对中国古籍数字化事业的关注。',
                  style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                    color: AppTheme.secondaryGray,
                    height: 1.8,
                  ),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 32),
                ElevatedButton.icon(
                  onPressed: () async {
                    final uri = Uri.parse('https://github.com/sheldonlidev/kaiyuanguji');
                    if (await canLaunchUrl(uri)) {
                      await launchUrl(uri, mode: LaunchMode.externalApplication);
                    }
                  },
                  icon: const Icon(Icons.code),
                  label: const Text('关注 GitHub 进展'),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppTheme.inkBlack,
                    foregroundColor: Colors.white,
                    padding: const EdgeInsets.symmetric(
                      horizontal: 32,
                      vertical: 16,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
