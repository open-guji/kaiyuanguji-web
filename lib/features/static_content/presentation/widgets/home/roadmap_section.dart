import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../../../../core/router/app_router.dart';
import '../../../../../core/theme/app_theme.dart';
import 'section_header.dart';

/// 路线图区：整合愿景与路线图
class RoadmapSection extends StatelessWidget {
  const RoadmapSection({super.key});

  @override
  Widget build(BuildContext context) {
    final size = MediaQuery.of(context).size;
    final isWide = size.width > 900;

    return Container(
      padding: const EdgeInsets.symmetric(vertical: 48, horizontal: 24),
      color: Colors.white,
      child: Column(
        children: [
          SectionHeader(
            title: '路线图',
            subtitle: '从数字化排版逐步走向 AI 智能化研究',
            onTap: () => context.go('/roadmap'),
          ),
          const SizedBox(height: 32),
          if (isWide)
            Column(
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: const [
                    Expanded(
                      child: RoadmapCard(
                        title: '专业排版',
                        description: '利用 LaTeX 引擎深度还原古籍之美，支持纵排、双行小注等复杂版式。',
                        imagePath: 'assets/images/typesetting.png',
                        slug: 'typesetting',
                      ),
                    ),
                    SizedBox(width: 24),
                    Expanded(
                      child: RoadmapCard(
                        title: '信息提取',
                        description: '集成最先进的古籍 OCR 与版面分析模型，实现文字与结构的自动化提取。',
                        imagePath: 'assets/images/ocr.png',
                        slug: 'extraction',
                      ),
                    ),
                    SizedBox(width: 24),
                    Expanded(
                      child: RoadmapCard(
                        title: '校对工具',
                        description: '提供图文对照、异体字映射的高效率协作环境，确保古籍数字化的准确性。',
                        imagePath: 'assets/images/toolkit.png',
                        slug: 'toolkit',
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 24),
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    const Spacer(),
                    const Expanded(
                      flex: 2,
                      child: RoadmapCard(
                        title: '储存检索',
                        description: '采用标准 XML/TEI 格式存储，建立可深度搜索的古籍全文数据库。',
                        imagePath: 'assets/images/hero.png',
                        slug: 'storage',
                      ),
                    ),
                    const SizedBox(width: 24),
                    const Expanded(
                      flex: 2,
                      child: RoadmapCard(
                        title: '智能训练',
                        description: '构建深度知识系统，训练专用 AI 大模型，推动古籍数字化走向智能化研究。',
                        imagePath: 'assets/images/intelligence.png',
                        slug: 'intelligence',
                      ),
                    ),
                    const Spacer(),
                  ],
                ),
              ],
            )
          else
            ListView.separated(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              itemCount: 5,
              separatorBuilder: (context, index) => const SizedBox(height: 24),
              itemBuilder: (context, index) {
                final items = [
                  const RoadmapCard(
                    title: '专业排版',
                    description: '利用 LaTeX 引擎深度还原古籍之美，支持纵排、双行小注等复杂版式。',
                    imagePath: 'assets/images/typesetting.png',
                    slug: 'typesetting',
                  ),
                  const RoadmapCard(
                    title: '信息提取',
                    description: '集成最先进的古籍 OCR 与版面分析模型，实现文字与结构的自动化提取。',
                    imagePath: 'assets/images/ocr.png',
                    slug: 'extraction',
                  ),
                  const RoadmapCard(
                    title: '校对工具',
                    description: '提供图文对照、异体字映射的高效率协作环境，确保古籍数字化的准确性。',
                    imagePath: 'assets/images/toolkit.png',
                    slug: 'toolkit',
                  ),
                  const RoadmapCard(
                    title: '储存检索',
                    description: '采用标准 XML/TEI 格式存储，建立可深度搜索的古籍全文数据库。',
                    imagePath: 'assets/images/hero.png',
                    slug: 'storage',
                  ),
                  const RoadmapCard(
                    title: '智能训练',
                    description: '构建深度知识系统，训练专用 AI 大模型，推动古籍数字化走向智能化研究。',
                    imagePath: 'assets/images/intelligence.png',
                    slug: 'intelligence',
                  ),
                ];
                return items[index];
              },
            ),
        ],
      ),
    );
  }
}

/// 路线图卡片
class RoadmapCard extends StatefulWidget {
  final String title;
  final String description;
  final String imagePath;
  final String slug;

  const RoadmapCard({
    super.key,
    required this.title,
    required this.description,
    required this.imagePath,
    required this.slug,
  });

  @override
  State<RoadmapCard> createState() => _RoadmapCardState();
}

class _RoadmapCardState extends State<RoadmapCard> {
  bool _isHovered = false;

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _isHovered = true),
      onExit: (_) => setState(() => _isHovered = false),
      child: GestureDetector(
        onTap: () => AppRouter.goToReader(context, widget.slug),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 300),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(16),
            boxShadow: [
              BoxShadow(
                color: AppTheme.inkBlack.withValues(
                  alpha: _isHovered ? 0.1 : 0.05,
                ),
                blurRadius: _isHovered ? 30 : 15,
                offset: Offset(0, _isHovered ? 12 : 8),
              ),
            ],
          ),
          clipBehavior: Clip.antiAlias,
          child: Column(
            children: [
              AspectRatio(
                aspectRatio: 16 / 9,
                child: Stack(
                  children: [
                    Positioned.fill(
                      child: Image.asset(widget.imagePath, fit: BoxFit.cover),
                    ),
                    Positioned.fill(
                      child: Container(
                        decoration: BoxDecoration(
                          gradient: LinearGradient(
                            begin: Alignment.topCenter,
                            end: Alignment.bottomCenter,
                            colors: [
                              Colors.transparent,
                              Colors.white.withValues(alpha: 0.2),
                              Colors.white,
                            ],
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.all(20),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Text(
                      widget.title,
                      style: Theme.of(context).textTheme.headlineSmall,
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 8),
                    Text(
                      widget.description,
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        color: AppTheme.secondaryGray,
                        height: 1.5,
                      ),
                      textAlign: TextAlign.center,
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
