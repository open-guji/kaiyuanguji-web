
const { fetchAllBooks } = require('./src/services/bookIndex');

// Mock fetch if strictly needed, but we want to test real network
// Node.js 18+ has native fetch.

async function testFetch() {
    console.log('Testing fetchAllBooks...');
    try {
        const books = await fetchAllBooks('github');
        console.log(`Fetched ${books.length} books.`);
        if (books.length > 0) {
            console.log('First book:', books[0]);
        } else {
            console.error('No books fetched!');
        }
    } catch (error) {
        console.error('Error fetching books:', error);
    }
}

testFetch();
