import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../../../core/layout/layout_shell.dart';
import '../../../../core/theme/app_theme.dart';
import '../../data/book_index_model.dart';
import '../../data/book_index_service.dart';

/// 古籍索引首页
/// 提供搜索和浏览功能
class BookIndexPage extends StatefulWidget {
  const BookIndexPage({super.key});

  @override
  State<BookIndexPage> createState() => _BookIndexPageState();
}

class _BookIndexPageState extends State<BookIndexPage> {
  final TextEditingController _searchController = TextEditingController();
  List<BookIndexItem> _allBooks = [];
  List<BookIndexItem> _filteredBooks = [];
  bool _isLoading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadBooks();
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  Future<void> _loadBooks() async {
    setState(() {
      _isLoading = true;
      _error = null;
    });

    try {
      final books = await BookIndexService.fetchAllBooks();
      setState(() {
        _allBooks = books;
        _filteredBooks = books;
        _isLoading = false;
      });
    } catch (e) {
      setState(() {
        _error = '加载失败: $e';
        _isLoading = false;
      });
    }
  }

  void _onSearch(String query) {
    setState(() {
      if (query.isEmpty) {
        _filteredBooks = _allBooks;
      } else {
        final lowerQuery = query.toLowerCase();
        _filteredBooks = _allBooks.where((item) {
          return item.name.toLowerCase().contains(lowerQuery) ||
              item.id.toLowerCase().contains(lowerQuery);
        }).toList();
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final isMobile = MediaQuery.of(context).size.width < 600;

    return LayoutShell(
      title: '古籍索引',
      child: SingleChildScrollView(
        padding: EdgeInsets.all(isMobile ? 16 : 32),
        child: Center(
          child: Container(
            constraints: const BoxConstraints(maxWidth: 900),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _buildHeader(context),
                const SizedBox(height: 32),
                _buildSearchBar(context),
                const SizedBox(height: 32),
                _buildContent(context, isMobile),
                const SizedBox(height: 48),
                LayoutShell.buildFooter(context),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildHeader(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          '古籍索引',
          style: Theme.of(context).textTheme.displaySmall?.copyWith(
                fontWeight: FontWeight.bold,
              ),
        ),
        const SizedBox(height: 8),
        Text(
          '标准化的古籍数字资源索引系统',
          style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                color: AppTheme.secondaryGray,
              ),
        ),
      ],
    );
  }

  Widget _buildSearchBar(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppTheme.borderColor),
        boxShadow: [
          BoxShadow(
            color: AppTheme.inkBlack.withValues(alpha: 0.05),
            blurRadius: 10,
            offset: const Offset(0, 2),
          ),
        ],
      ),
      child: TextField(
        controller: _searchController,
        onChanged: _onSearch,
        decoration: InputDecoration(
          hintText: '搜索古籍名称或ID...',
          hintStyle: TextStyle(color: AppTheme.secondaryGray.withValues(alpha: 0.6)),
          prefixIcon: const Icon(Icons.search, color: AppTheme.secondaryGray),
          suffixIcon: _searchController.text.isNotEmpty
              ? IconButton(
                  icon: const Icon(Icons.clear, color: AppTheme.secondaryGray),
                  onPressed: () {
                    _searchController.clear();
                    _onSearch('');
                  },
                )
              : null,
          border: InputBorder.none,
          contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
        ),
      ),
    );
  }

  Widget _buildContent(BuildContext context, bool isMobile) {
    if (_isLoading) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(48),
          child: Column(
            children: [
              CircularProgressIndicator(color: AppTheme.vermilionRed),
              SizedBox(height: 16),
              Text('正在加载古籍列表...'),
            ],
          ),
        ),
      );
    }

    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(48),
          child: Column(
            children: [
              const Icon(Icons.error_outline, size: 48, color: AppTheme.vermilionRed),
              const SizedBox(height: 16),
              Text(_error!, style: const TextStyle(color: AppTheme.vermilionRed)),
              const SizedBox(height: 16),
              ElevatedButton(
                onPressed: _loadBooks,
                child: const Text('重试'),
              ),
            ],
          ),
        ),
      );
    }

    if (_filteredBooks.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(48),
          child: Column(
            children: [
              Icon(Icons.search_off, size: 48, color: AppTheme.secondaryGray.withValues(alpha: 0.5)),
              const SizedBox(height: 16),
              Text(
                _searchController.text.isEmpty ? '暂无收录古籍' : '未找到匹配的古籍',
                style: TextStyle(color: AppTheme.secondaryGray),
              ),
            ],
          ),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(
              _searchController.text.isEmpty ? '最近收录' : '搜索结果',
              style: Theme.of(context).textTheme.headlineSmall,
            ),
            Text(
              '共 ${_filteredBooks.length} 条记录',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ),
        const SizedBox(height: 16),
        _buildBookList(context, isMobile),
      ],
    );
  }

  Widget _buildBookList(BuildContext context, bool isMobile) {
    return ListView.separated(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      itemCount: _filteredBooks.length,
      separatorBuilder: (context, index) => const SizedBox(height: 12),
      itemBuilder: (context, index) {
        final item = _filteredBooks[index];
        return _BookListItem(item: item);
      },
    );
  }
}

/// 单个古籍列表项
class _BookListItem extends StatelessWidget {
  final BookIndexItem item;

  const _BookListItem({required this.item});

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.white,
      borderRadius: BorderRadius.circular(8),
      child: InkWell(
        onTap: () => context.go('/book-index/${item.id}'),
        borderRadius: BorderRadius.circular(8),
        child: Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: AppTheme.borderColor),
          ),
          child: Row(
            children: [
              // 类型图标
              Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(
                  color: _getTypeColor().withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Icon(
                  _getTypeIcon(),
                  color: _getTypeColor(),
                  size: 24,
                ),
              ),
              const SizedBox(width: 16),
              // 信息
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      item.name,
                      style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                            fontWeight: FontWeight.w600,
                          ),
                    ),
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        _buildTag(item.typeLabel, _getTypeColor()),
                        const SizedBox(width: 8),
                        _buildTag(
                          item.statusLabel,
                          item.isDraft ? AppTheme.secondaryGray : Colors.green,
                        ),
                        const SizedBox(width: 8),
                        Text(
                          'ID: ${item.id}',
                          style: Theme.of(context).textTheme.bodySmall?.copyWith(
                                color: AppTheme.secondaryGray.withValues(alpha: 0.8),
                                fontFamily: 'monospace',
                              ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              // 箭头
              Icon(
                Icons.chevron_right,
                color: AppTheme.secondaryGray.withValues(alpha: 0.5),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildTag(String label, Color color) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 11,
          color: color,
          fontWeight: FontWeight.w500,
        ),
      ),
    );
  }

  IconData _getTypeIcon() {
    switch (item.type) {
      case BookResourceType.work:
        return Icons.auto_stories;
      case BookResourceType.collection:
        return Icons.library_books;
      case BookResourceType.book:
        return Icons.menu_book;
    }
  }

  Color _getTypeColor() {
    switch (item.type) {
      case BookResourceType.work:
        return Colors.blue;
      case BookResourceType.collection:
        return Colors.purple;
      case BookResourceType.book:
        return AppTheme.vermilionRed;
    }
  }
}
