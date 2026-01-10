import 'package:flutter/material.dart';
import '../../../../../core/theme/app_theme.dart';

/// 英雄区：项目门户
class HeroSection extends StatelessWidget {
  final VoidCallback onRoadmapTap;
  final VoidCallback onAssistantTap;
  final VoidCallback onJoinTap;

  const HeroSection({
    super.key,
    required this.onRoadmapTap,
    required this.onAssistantTap,
    required this.onJoinTap,
  });

  @override
  Widget build(BuildContext context) {
    final size = MediaQuery.of(context).size;
    final isMobile = size.width < 600;

    return Container(
      width: double.infinity,
      height: isMobile ? 500 : 550,
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            AppTheme.paperBackground,
            AppTheme.borderColor.withValues(alpha: 0.3),
            AppTheme.paperBackground,
          ],
        ),
      ),
      child: Stack(
        children: [
          // 背景图 - 使用生成的英雄图
          Positioned.fill(
            child: Opacity(
              opacity: 0.2,
              child: Image.asset('assets/images/hero.png', fit: BoxFit.cover),
            ),
          ),
          // 内容层
          Center(
            child: Container(
              constraints: const BoxConstraints(maxWidth: 1000),
              padding: const EdgeInsets.symmetric(horizontal: 24),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(
                    '开源古籍',
                    style: Theme.of(context).textTheme.displayLarge?.copyWith(
                      fontSize: isMobile ? 48 : 72,
                      letterSpacing: 10,
                      color: AppTheme.inkBlack,
                    ),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 24),
                  Text(
                    '让科技赋予古籍数字生命',
                    style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                      color: AppTheme.inkBlack.withValues(alpha: 0.9),
                      letterSpacing: 2,
                    ),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 12),
                  Text(
                    '全线软件基于 Apache-2.0 协议开源 · 自由使用 · 共享共建',
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      color: AppTheme.secondaryGray,
                      letterSpacing: 1.2,
                      fontStyle: FontStyle.italic,
                    ),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 16),
                  Container(width: 60, height: 2, color: AppTheme.vermilionRed),
                  const SizedBox(height: 32),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 48),
                    child: Text(
                      '通过技术手段推动古籍的数字化、校对及开源存储，构建古籍知识图谱与 AI 模型',
                      style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                        color: AppTheme.inkBlack,
                        height: 2.0,
                        fontWeight: FontWeight.w500,
                      ),
                      textAlign: TextAlign.center,
                    ),
                  ),
                  const SizedBox(height: 48),
                  Wrap(
                    spacing: 16,
                    runSpacing: 16,
                    alignment: WrapAlignment.center,
                    children: [
                      _HeroButton(onPressed: onRoadmapTap, label: '路线图'),
                      _HeroButton(onPressed: onAssistantTap, label: '古籍助手'),
                      _HeroButton(onPressed: onJoinTap, label: '参与开发'),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 英雄区专用按钮
class _HeroButton extends StatelessWidget {
  final VoidCallback onPressed;
  final String label;

  const _HeroButton({required this.onPressed, required this.label});

  @override
  Widget build(BuildContext context) {
    return OutlinedButton(
      onPressed: onPressed,
      style: OutlinedButton.styleFrom(
        padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 20),
        side: const BorderSide(color: AppTheme.vermilionRed),
        foregroundColor: AppTheme.vermilionRed,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
      ),
      child: Text(
        label,
        style: const TextStyle(
          fontSize: 18,
          fontWeight: FontWeight.w600,
          letterSpacing: 2,
        ),
      ),
    );
  }
}
