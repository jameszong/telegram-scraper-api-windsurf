// Add to api/src/index.js - Temporary cleanup endpoint
app.post('/admin/clear-r2', async (c) => {
  try {
    console.log('Debug: Starting R2 bucket cleanup...');
    
    // List all objects in the bucket
    const listResult = await c.env.BUCKET.list();
    console.log(`Debug: Found ${listResult.objects.length} objects in R2`);
    
    let deletedCount = 0;
    
    // Delete each object
    for (const object of listResult.objects) {
      await c.env.BUCKET.delete(object.key);
      console.log(`Debug: Deleted R2 object: ${object.key}`);
      deletedCount++;
    }
    
    console.log(`Debug: R2 cleanup complete. Deleted ${deletedCount} objects`);
    
    return c.json({
      success: true,
      deleted: deletedCount,
      message: `Successfully deleted ${deletedCount} objects from R2`
    });
    
  } catch (error) {
    console.error('Error clearing R2 bucket:', error);
    return c.json({ 
      success: false, 
      error: error.message 
    }, 500);
  }
});
